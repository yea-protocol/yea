"""FastMCP 4 (SPEC-mcp-py, "FastMCP 4"): the same routine, through FastMCP's supported seams.
``job()`` and ``guard()`` detect a FastMCP server and come here; install the extra with
``yea-mcp[fastmcp]``.

SDK seams: ``Tool.from_function`` honours the synthesized signature; middleware asks with
``InputRequiredToolResult`` on 2026 and ``session.elicit_form`` on 2025; ``context.copy`` changes
the arguments the tool gets; ``on_list_tools`` returns FastMCP ``Tool`` objects; a
``TransformedTool`` runs its parent directly, skipping middleware."""

from __future__ import annotations

import inspect
import typing
from collections.abc import Callable
from typing import Any

import mcp_types as t
from fastmcp import Context as FastContext
from fastmcp import FastMCP
from fastmcp.server.middleware import Middleware
from fastmcp.tools import Tool
from fastmcp.tools.base import InputRequiredToolResult, ToolResult
from pydantic_core import to_jsonable_python
from yea import Plan

from .call import described_risk, JobDef, Req, Yea, run_job
from .guard import Guarded, job_annotations, job_meta
from .signature import job_wrapper


def _req(ctx: FastContext) -> Req:
    rc = ctx.request_context
    return Req(rc, ctx.session, ctx.request_id, getattr(rc, "protocol_version", None), ctx.request_state,
               ctx.input_responses)


def add_job(y: Yea, server: FastMCP, plan_fn: Callable[..., Any], job: JobDef, title: str | None,
            description: str | None, annotations: dict, meta: dict) -> None:
    async def run(input: dict, plan: Any, preview: bool, ctx: FastContext) -> Any:
        return await run_job(y, job, input, preview, _req(ctx), plan)

    fn = job_wrapper(plan_fn, job.name, FastContext, run)
    # Built with FastMCP's default task mode (forbidden), so a job never runs as a background task.
    server.add_tool(Tool.from_function(fn, name=job.name, title=title, description=description,
                                       annotations=t.ToolAnnotations(**annotations), meta=meta))


def add_undo(server: FastMCP, undo: Callable[..., Any]) -> None:
    async def undo_tool(receipt: str, ctx: FastContext) -> t.CallToolResult:
        """Undo a job by its receipt id, within its undo window."""
        return await undo(receipt, ctx)

    server.add_tool(Tool.from_function(undo_tool, name="undo",
                                       description="Undo a job by its receipt id, within its undo window.",
                                       annotations=t.ToolAnnotations(read_only_hint=False, destructive_hint=True,
                                                                     idempotent_hint=True)))


def _runs_as_task(tool: Any) -> bool:
    return getattr(tool, "task_config", None) is not None and tool.task_config.supports_tasks()


def has_tool(server: FastMCP, name: str) -> bool:
    """Whether ``server`` already registers a tool named ``name``. FastMCP's lookups are async and
    job()/guard() aren't, so this reads the local provider's registry (a provisional seam)."""
    return any(k.startswith(f"tool:{name}@") for k in getattr(server.local_provider, "_components", {}))


def _failed(r: Any) -> bool:
    return isinstance(r, InputRequiredToolResult) or not isinstance(r, ToolResult) or r.is_error is True


def _with_receipt(r: ToolResult, receipt: dict) -> ToolResult:
    return ToolResult(content=r.content, structured_content=r.structured_content,
                      meta={**(r.meta or {}), "dev.yea/receipt": receipt}, is_error=r.is_error)


def _with_note(r: ToolResult, note: str) -> ToolResult:
    return ToolResult(content=[*r.content, t.TextContent(type="text", text=note)],
                      structured_content=r.structured_content, meta=r.meta, is_error=r.is_error)


class FastMCPGuard(Middleware):
    """One per FastMCP server, installed first by ``guard()``. It turns each guarded tool in the
    server's own provider (every version) into an approval wrapper **in place**: the same ``Tool``
    object keeps its name, version, auth, timeout and everything else, but its function becomes
    the wrapper, whose only way to act is a private copy of the original. So every route that runs
    the tool, including a transform that captured the object earlier, runs the wrapper. It's
    checked on every message, so tools registered or re-registered later are wrapped before
    anything can call them."""

    def __init__(self, y: Yea, server: FastMCP):
        self.y = y
        self.server = server
        self.tools: dict[str, Guarded] = {}
        self._originals: set[int] = set()  # id() of original functions, to spot copies taken before wrapping
        self._problem: str | None = None  # a guard that can't be kept: every tool call is refused

    def add(self, name: str, g: Guarded) -> None:
        if name in self.tools:
            raise ValueError(f"guard(): {name} is already guarded on this server")
        self.tools[name] = g

    async def on_message(self, context: Any, call_next: Any) -> Any:
        try:
            await self._ensure_wrapped()
            self._problem = None
        except ValueError as e:
            self._problem = str(e)
        return await call_next(context)

    async def on_call_tool(self, context: Any, call_next: Any) -> Any:
        """While a guard can't be kept, no tool runs: the unguarded one might be reachable by
        another name, so failing every call is the only safe answer."""
        if self._problem:
            return ToolResult(content=[t.TextContent(type="text", text=f"✗ {self._problem}; nothing was run")],
                              is_error=True)
        return await call_next(context)

    async def _ensure_wrapped(self) -> None:
        tools = list(await self.server.local_provider.list_tools())  # every version, the stored objects
        present = {tool.name for tool in tools}
        for name in self.tools:
            if name not in present:
                raise ValueError(f"guard(): {name} isn't one of this server's own tools; guard a mounted server's or "
                                 "an app's tool on the server or app that defines it")
        for tool in tools:
            if tool.name in self.tools and not _wrapped(tool):
                self._wrap_in_place(tool, self.tools[tool.name])  # no await: nothing runs mid-swap
        # Verify on a fresh listing: a provider rule (enable/disable) hands out copies, and a wrap
        # that landed on a copy leaves the stored tool as it was. Every call path would then re-copy
        # the unwrapped original, so refuse rather than trust the first listing.
        for tool in await self.server.local_provider.list_tools():
            self._check_wrapped(tool)
            self._check_parents(tool)  # local tools only: a wrap in place also covers other holders

    def _check_wrapped(self, tool: Any) -> None:
        if _wrapped(tool):
            return
        if tool.name in self.tools:
            raise ValueError(f"guard(): {tool.name} couldn't be wrapped: a rule on this server's provider (enable or "
                             "disable) hands out copies of it; guard it without provider-level rules")
        if id(getattr(tool, "fn", None)) in self._originals:
            raise ValueError(f"{tool.name} runs the same function as a guarded tool under another name")

    def _check_parents(self, tool: Any) -> None:
        """A transform built from a copy of a guarded tool taken before it was wrapped would run
        the original: refuse until it's rebuilt."""
        parent = getattr(tool, "parent_tool", None)
        while parent is not None:
            fn = getattr(parent, "fn", None)
            if (parent.name in self.tools or id(fn) in self._originals) and not _wrapped(parent):
                raise ValueError(f"{tool.name} was built from {parent.name} before the guard wrapped it; build it "
                                 "after the first request, or from the tool the server returns now")
            parent = getattr(parent, "parent_tool", None)

    def _wrap_in_place(self, tool: Any, g: Guarded) -> None:
        fn = getattr(tool, "fn", None)
        if fn is None:
            raise ValueError(f"guard(): {tool.name} isn't a function tool, so it can't be wrapped")
        if "dev.yea/job" in (tool.meta or {}):
            raise ValueError(f"guard(): {tool.name} is already a job tool")
        if _runs_as_task(tool):
            raise ValueError(f"guard(): {tool.name} runs as a background task, which a guard doesn't support yet")
        if "preview" in ((tool.parameters or {}).get("properties") or {}):
            raise ValueError(f"guard(): {tool.name} has its own preview argument, which the guard would shadow")
        inner = tool.model_copy()  # the original behaviour, reachable only through apply
        injected = _injected(fn)
        has_output = tool.output_schema is not None
        job = JobDef(tool.name, g.risk, g.revert, g.confirm_with, guarded=True,
                     own_results_are_errors=lambda: has_output, failed=_failed, with_receipt=_with_receipt,
                     with_note=_with_note)

        async def run(input: dict, plan: Any, preview: bool, ctx: FastContext) -> Any:
            return await run_job(self.y, job, input, preview, _req(ctx), plan)

        wrapper_fn = job_wrapper(_plan_fn(inner, g, injected), tool.name, FastContext, run, frozenset(injected))
        wrapper_fn.__yea_guard__ = True  # type: ignore[attr-defined]
        shape = Tool.from_function(wrapper_fn, name=tool.name)  # how FastMCP derives the listed parameters
        given = tool.annotations.model_dump(by_alias=True, exclude_none=True) if tool.annotations else {}
        self._originals.add(id(fn))
        tool.fn = wrapper_fn
        tool.parameters = shape.parameters
        tool.annotations = t.ToolAnnotations(**job_annotations(given))
        tool.meta = {**(tool.meta or {}), **job_meta(g.risk, g.revert is not None)}


def _wrapped(tool: Any) -> bool:
    return getattr(getattr(tool, "fn", None), "__yea_guard__", False) is True


def _injected(fn: Callable[..., Any]) -> set[str]:
    """Parameters FastMCP fills in itself (``Context``, ``Depends(...)``): not part of the input."""
    from fastmcp.server.dependencies import without_injected_parameters

    kept = set(inspect.signature(without_injected_parameters(fn)).parameters)
    return set(inspect.signature(fn).parameters) - kept


def _plan_fn(inner: Any, g: Guarded, injected: set[str]) -> Callable[..., Any]:
    """A plan function with the original's signature: it asks ``describe`` for the plan, whose
    ``apply`` is the private copy of the original, run with the same arguments."""
    fn = inner.fn

    async def plan(**kw: Any) -> list[Plan]:
        args = {k: v for k, v in kw.items() if k not in injected}
        d = g.describe(to_jsonable_python(args, by_alias=True))
        d = await d if inspect.isawaitable(d) else d
        return [Plan(d["summary"], d["effects"], apply=lambda: inner.run(args), uses=d.get("uses"),
                     risk=described_risk(d), undo_window=d.get("undo_window"))]

    plan.__signature__ = inspect.signature(fn)  # type: ignore[attr-defined]
    plan.__annotations__ = typing.get_type_hints(fn)
    return plan
