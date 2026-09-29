"""YEA's ``undo`` tool (SPEC-mcp-py, SPEC-approval §7): registered once per server, the first time a
job with ``revert`` is added, and answering only for that server's receipts and tools."""

from __future__ import annotations

import time
from collections.abc import Callable
from typing import Any

import mcp_types as t
from mcp.server.mcpserver import Context
from yea.approval import undo_receipt
from yea.store import is_receipt_id
from yea.text import printable

from .call import Yea, _maybe, caller_of, is_partial
from .result import error_result
from .util import fastmcp_of

UNDO_DESCRIPTION = "Undo a job by its receipt id, within its undo window."
UNDO_ANNOTATIONS = t.ToolAnnotations(read_only_hint=False, destructive_hint=True, idempotent_hint=True)


def add_undo_tool(y: Yea, server: Any) -> dict[str, Callable[..., Any]]:
    """Register ``undo`` on ``server``; returns the tool-to-revert map it reads, for jobs to add to."""
    reverts: dict[str, Callable[..., Any]] = {}

    async def undo(receipt: str, ctx: Context) -> t.CallToolResult:
        return await undo_call(y, reverts, receipt, ctx)

    if (fm := fastmcp_of(server)) is not None:
        fm.add_undo(server, lambda receipt, ctx: undo_call(y, reverts, receipt, ctx))
    else:
        server.add_tool(undo, name="undo", description=UNDO_DESCRIPTION, annotations=UNDO_ANNOTATIONS)
    return reverts


def has_tool(server: Any, name: str) -> bool:
    """Whether ``server`` already has a tool ``name``. The SDKs' lookups are async and job()/guard()
    aren't, so this reads each SDK's registry (a provisional seam, like ``server.middleware``)."""
    if (fm := fastmcp_of(server)) is not None:
        return fm.has_tool(server, name)
    return server._tool_manager.get_tool(name) is not None  # a rename in the SDK raises here, never passes


async def undo_call(y: Yea, reverts: dict[str, Callable[..., Any]], id: str, ctx: Any) -> t.CallToolResult:
    """``undo(receipt)``: the core's ``undo_receipt``, for this server's receipts and tools only."""
    try:
        rctx = getattr(ctx, "request_context", ctx)
        sub = caller_of(y, rctx)
        found = await y.store.get_receipt(id) if is_receipt_id(id) else None
        revert = reverts.get(found["tool"]) if found else None  # no revert here: unknown, like another server's

        async def call_revert(r: dict) -> Any:
            return await _maybe(revert({"input": r.get("input"), "planHash": r.get("planHash"),
                                        "result": r.get("result")}, ctx))

        out = await undo_receipt(y.store, id if revert else None, y.service_id, sub, int(time.time()), call_revert)
        if out.kind == "undone" and out.receipt is not None:
            return t.CallToolResult(content=[t.TextContent(type="text", text=f"↶ undid {out.receipt['id']}: "
                                                                               f"{printable(out.receipt['summary'])}")],
                                    structured_content={"undone": out.receipt["id"]})
        return error_result([f"✗ {out.why}; nothing was undone"])
    except Exception as e:  # noqa: BLE001
        if is_partial(e):  # a revert that may have half-happened says so, never "nothing was undone"
            return error_result([f"✗ undo failed part-way: {printable(str(e))}"])
        return error_result([f"✗ undo failed: {printable(str(e))}; nothing was undone, and it can be tried again"])
