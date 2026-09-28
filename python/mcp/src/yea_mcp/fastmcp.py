"""FastMCP 4 (SPEC-mcp-py, "FastMCP 4"): the same routine, through FastMCP's supported seams.
``job()`` and ``guard()`` detect a FastMCP server and come here; install the extra with
``yea-mcp[fastmcp]``.

SDK seams: ``Tool.from_function`` honours the synthesized signature; middleware asks with
``InputRequiredToolResult`` on 2026 and ``session.elicit_form`` on 2025; ``context.copy`` changes
the arguments the tool gets; ``on_list_tools`` returns FastMCP ``Tool`` objects; a
``TransformedTool`` runs its parent directly, skipping middleware."""

from __future__ import annotations

import copy
import inspect
from collections.abc import Callable
from typing import Any

import mcp_types as t
from fastmcp import Context as FastContext
from fastmcp import FastMCP
from fastmcp.server.middleware import Middleware
from fastmcp.tools import Tool
from fastmcp.tools.base import InputRequiredToolResult, ToolResult
from fastmcp.tools.tool_transform import TransformedTool
from yea import Plan

from .call import JobDef, Req, Yea, run_job
from .guard import Guarded, job_annotations, job_meta
from .render import error_result
from .signature import job_wrapper


def is_fastmcp(server: Any) -> bool:
    return isinstance(server, FastMCP)


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


def _as_tool_result(out: Any) -> ToolResult:
    if isinstance(out, ToolResult):
        return out
    if isinstance(out, t.InputRequiredResult):
        return InputRequiredToolResult(out)
    return ToolResult.from_mcp_result(out)


def _failed(r: Any) -> bool:
    return isinstance(r, InputRequiredToolResult) or not isinstance(r, ToolResult) or r.is_error is True


def _with_receipt(r: ToolResult, receipt: dict) -> ToolResult:
    return ToolResult(content=r.content, structured_content=r.structured_content,
                      meta={**(r.meta or {}), "dev.yea/receipt": receipt}, is_error=r.is_error)


def _with_note(r: ToolResult, note: str) -> ToolResult:
    return ToolResult(content=[*r.content, t.TextContent(type="text", text=note)],
                      structured_content=r.structured_content, meta=r.meta, is_error=r.is_error)


class FastMCPGuard(Middleware):
    """One per FastMCP server: its guarded tools, installed by ``guard()`` itself."""

    def __init__(self, y: Yea, server: FastMCP):
        self.y = y
        self.server = server
        self.tools: dict[str, Guarded] = {}

    async def on_list_tools(self, context: Any, call_next: Any) -> Any:
        return [self._advertise(tool) for tool in await call_next(context)]

    def _advertise(self, tool: Tool) -> Tool:
        g = self.tools.get(tool.name)
        if g is None:
            return tool
        params = copy.deepcopy(tool.parameters)
        params.setdefault("properties", {}).setdefault("preview", {"type": "boolean", "default": False})
        given = tool.annotations.model_dump(by_alias=True, exclude_none=True) if tool.annotations else {}
        return tool.model_copy(update={"parameters": params,
                                       "annotations": t.ToolAnnotations(**job_annotations(given)),
                                       "meta": {**(tool.meta or {}), **job_meta(None, g.revert is not None)}})

    async def on_call_tool(self, context: Any, call_next: Any) -> Any:
        name = context.message.name
        tool = await self.server.get_tool(name)
        if tool is None:
            return await call_next(context)
        if isinstance(tool, TransformedTool) and self._reaches_guarded(tool):
            return _as_tool_result(error_result([f"✗ {name} is a transform of a guarded tool, which would skip its "
                                                 "approval; nothing was run"]))
        g = self.tools.get(name)
        if g is None:
            return await call_next(context)
        return _as_tool_result(await self._call(context, call_next, tool, g))

    def _reaches_guarded(self, tool: Any) -> bool:
        while isinstance(tool, TransformedTool):
            tool = tool.parent_tool
            if tool.name in self.tools:
                return True
        return False

    async def _call(self, context: Any, call_next: Any, tool: Tool, g: Guarded) -> Any:
        name = tool.name
        if getattr(tool, "task_config", None) is not None and tool.task_config.supports_tasks():
            return error_result([f"✗ {name} runs as a background task, which a guard doesn't support yet; nothing was run"])
        if "preview" in ((tool.parameters or {}).get("properties") or {}):
            return error_result([f"✗ guard(): {name} has its own preview argument, which the guard would shadow; "
                                 "nothing was run"])
        args = dict(context.message.arguments or {})
        preview = args.pop("preview", False)
        if not isinstance(preview, bool):
            return error_result(["✗ preview must be true or false; nothing was run"])
        stripped = context.copy(message=context.message.model_copy(update={"arguments": args}))

        async def plan() -> list[Plan]:
            d = g.describe(dict(args))
            d = await d if inspect.isawaitable(d) else d
            return [Plan(d["summary"], d["effects"], apply=lambda: call_next(stripped), uses=d.get("uses"),
                         risk=d.get("risk"), undo_window=d.get("undo_window"))]

        has_output = tool.output_schema is not None
        job = JobDef(name, None, g.revert, g.confirm_with, guarded=True, own_results_are_errors=lambda: has_output,
                     failed=_failed, with_receipt=_with_receipt, with_note=_with_note)
        return await run_job(self.y, job, args, preview, _req(context.fastmcp_context), plan)
