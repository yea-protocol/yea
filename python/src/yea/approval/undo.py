"""Undoing a job from its receipt, once, within its window (SPEC-approval §7)."""

from __future__ import annotations

import secrets
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from .._json import b64url_encode
from ..store import ApprovalStore, is_receipt_id


@dataclass(frozen=True)
class UndoResult:
    """``undone`` | ``refused`` (with why)."""

    kind: str
    why: str | None = None
    receipt: dict | None = None


async def undo_receipt(store: ApprovalStore, receipt_id: Any, service: str, sub: str, now: int,
                       revert: Callable[[dict], Any]) -> UndoResult:
    """§7: check the id's format, then the server, principal, reversibility and window, then
    claim, revert, and mark done (or release the claim if revert fails, so it can be tried again).
    Servers on one machine share the store, so another server's receipt is "no such receipt".
    ``revert`` gets the stored job receipt (``input``, ``planHash``, ``result``, …) and may be async."""
    r = await store.get_receipt(receipt_id) if is_receipt_id(receipt_id) else None
    why = _undo_refusal(r, service, sub, now)
    if why or r is None:
        return UndoResult("refused", why or "no such receipt")
    if not await store.claim_undo(receipt_id):
        return UndoResult("refused", "this job was already undone")
    try:
        out = revert(r)
        if hasattr(out, "__await__"):
            await out
    except BaseException:
        await store.release_undo(receipt_id)
        raise
    await store.mark_undone(receipt_id)
    return UndoResult("undone", receipt=r)


def _undo_refusal(r: dict | None, service: str, sub: str, now: int) -> str | None:
    if r is None or r.get("service") != service or r.get("sub") != sub:
        return "no such receipt"
    undo = r.get("undo")
    if not isinstance(undo, dict) or type(undo.get("until")) is not int:
        return "this job can never be undone"
    return "the undo window has closed" if now > undo["until"] else None


def new_receipt_id() -> str:
    """``r_`` and 12 b64url characters (9 random bytes)."""
    return "r_" + b64url_encode(secrets.token_bytes(9))
