"""What a job call works with: the process-wide context, a job's definition, the request, and the call in progress."""

from __future__ import annotations

import inspect
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from mcp_types.methods import is_input_required
from yea.approval import HashedPlan, Policy
from yea.store import ApprovalStore

from ..keys import Pinned

Result = Any  # a CallToolResult, an InputRequiredResult, or (guard) the original's wire mapping
NOTHING_RAN = "nothing was run"
BAD_STATE = ("this approval is invalid, expired, already used, or for another call; nothing was run. "
             "Call the tool again to ask again.")


@dataclass
class Yea:
    """The one approval context per process that ``yea()`` creates."""

    name: str
    transport: str
    store: ApprovalStore
    shared_memory: bool  # a MemoryStore without a promise that one process serves every request
    principal: Pinned
    policy: str | None
    tighten: Any
    service_id: str
    sub: Callable[[Any], str]


def wire_failed(result: Any) -> bool:
    """``MCPServer``'s ``call_next`` hands back the wire mapping: read it structurally, assume no class."""
    if is_input_required(result):
        return True
    return result.get("isError") is True if isinstance(result, dict) else True


def wire_with_receipt(result: Any, receipt: dict) -> Any:
    return {**result, "_meta": {**(result.get("_meta") or {}), "dev.yea/receipt": receipt}}


def wire_with_note(result: Any, note: str) -> Any:
    return {**result, "content": [*(result.get("content") or []), {"type": "text", "text": note}]}


@dataclass
class JobDef:
    """A job as the routine runs it: from ``job()`` or from ``guard()``. A guard's original result
    is the SDK's own shape, so how to read it and add to it is per SDK."""

    name: str
    risk: str | None
    revert: Callable[..., Any] | None
    confirm_with: Callable[[HashedPlan, dict], str] | None
    guarded: bool = False
    own_results_are_errors: Callable[[], bool] = lambda: False
    failed: Callable[[Any], bool] = wire_failed
    with_receipt: Callable[[Any, dict], Any] = wire_with_receipt
    with_note: Callable[[Any, str], Any] = wire_with_note


@dataclass
class Req:
    """What the routine needs from the request, whichever SDK surface it came through."""

    rctx: Any  # the ServerRequestContext, which sub() gets
    session: Any
    request_id: Any
    protocol_version: str | None
    state: Any  # the plaintext request state, or None
    responses: Any  # the input responses, or None


@dataclass
class Call:
    y: Yea
    job: JobDef
    input: dict
    req: Req
    sub: str
    now: int
    policy: Policy
    plans: list[HashedPlan]
    plan: Callable[[], Awaitable[Any]]  # re-plans for each round of a 2025 in-call ask


async def _maybe(v: Any) -> Any:
    return await v if inspect.isawaitable(v) else v
