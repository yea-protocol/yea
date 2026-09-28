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

from .call import JobDef, Req, Yea, run_job
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


def _failed(r: Any) -> bool:
    return isinstance(r, InputRequiredToolResult) or not isinstance(r, ToolResult) or r.is_error is True


def _with_receipt(r: ToolResult, receipt: dict) -> ToolResult:
    return ToolResult(content=r.content, structured_content=r.structured_content,
                      meta={**(r.meta or {}), "dev.yea/receipt": receipt}, is_error=r.is_error)


def _with_note(r: ToolResult, note: str) -> ToolResult:
    return ToolResult(content=[*r.content, t.TextContent(type="text", text=note)],
                      structured_content=r.structured_content, meta=r.meta, is_error=r.is_error)


class FastMCPGuard(Middleware):
    """One per FastMCP server, installed first by ``guard()``. It keeps each guarded tool in the
    server's own provider replaced by an approval wrapper: the wrapper has the original's
    signature plus ``preview``, and its only way to act is the original's ``run``. Every route that
    runs the tool (a ``Namespace`` copy, a transform, a hashed name, search) runs the wrapper, so
    nothing depends on which name a call used. The replacement is checked on every message, so a
    tool registered or re-registered later is wrapped before anything can call it."""

    def __init__(self, y: Yea, server: FastMCP):
        self.y = y
        self.server = server
        self.tools: dict[str, Guarded] = {}
        self._wrappers: dict[str, Tool] = {}
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
        provider = self.server.local_provider
        for name, g in self.tools.items():
            current = await provider.get_tool(name)
            if current is not None and current is self._wrappers.get(name):
                continue
            if current is None:
                raise ValueError(f"guard(): {name} isn't one of this server's own tools; guard a mounted server's or "
                                 "an app's tool on the server or app that defines it")
            wrapper = self._wrap(current, g)
            provider.remove_tool(name)
            provider.add_tool(wrapper)
            self._wrappers[name] = await provider.get_tool(name) or wrapper

    def _wrap(self, original: Tool, g: Guarded) -> Tool:
        fn = getattr(original, "fn", None)
        if fn is None:
            raise ValueError(f"guard(): {original.name} isn't a function tool, so it can't be wrapped")
        if getattr(original, "task_config", None) is not None and original.task_config.supports_tasks():
            raise ValueError(f"guard(): {original.name} runs as a background task, which a guard doesn't support yet")
        if "preview" in ((original.parameters or {}).get("properties") or {}):
            raise ValueError(f"guard(): {original.name} has its own preview argument, which the guard would shadow")
        has_output = original.output_schema is not None
        job = JobDef(original.name, None, g.revert, g.confirm_with, guarded=True,
                     own_results_are_errors=lambda: has_output, failed=_failed, with_receipt=_with_receipt,
                     with_note=_with_note)

        async def run(input: dict, plan: Any, preview: bool, ctx: FastContext) -> Any:
            return await run_job(self.y, job, input, preview, _req(ctx), plan)

        wrapper_fn = job_wrapper(_plan_fn(original, g), original.name, FastContext, run)
        given = original.annotations.model_dump(by_alias=True, exclude_none=True) if original.annotations else {}
        return Tool.from_function(
            wrapper_fn, name=original.name, title=original.title, description=original.description,
            tags=set(original.tags or ()), annotations=t.ToolAnnotations(**job_annotations(given)),
            output_schema=original.output_schema,
            meta={**(original.meta or {}), **job_meta(None, g.revert is not None)})


def _plan_fn(original: Tool, g: Guarded) -> Callable[..., Any]:
    """A plan function with the original's signature: it asks ``describe`` for the plan, whose
    ``apply`` is the original's own ``run`` with the same arguments."""
    fn = original.fn  # type: ignore[attr-defined]
    hints = typing.get_type_hints(fn)
    context_params = {n for n, a in hints.items() if inspect.isclass(a) and issubclass(a, FastContext)}

    async def plan(**kw: Any) -> list[Plan]:
        args = {k: v for k, v in kw.items() if k not in context_params}
        d = g.describe(to_jsonable_python(args, by_alias=True))
        d = await d if inspect.isawaitable(d) else d
        return [Plan(d["summary"], d["effects"], apply=lambda: original.run(args), uses=d.get("uses"),
                     risk=d.get("risk"), undo_window=d.get("undo_window"))]

    plan.__signature__ = inspect.signature(fn)  # type: ignore[attr-defined]
    plan.__annotations__ = hints
    return plan
