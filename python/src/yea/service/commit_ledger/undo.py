"""Undoing a receipt (SPEC §4.5): at most once, inside its undo window, run the plan's ``revert`` and
issue the undo receipt with its effects inverted. A repeat gets the original outcome. Like
ts/src/service/commit-ledger/undo.ts."""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from typing import Any

from ...errors import YeaError
from ..plan import CommitCtx
from ..replies import error_reply, event_frame, replay_of, reply_frame
from ..util import Emit, _call, _iso, random_id
from .records import StoredReceipt, Undo
from .runs import Run, forget, forget_if_cancelled, in_doubt, outcome

_INVERSE = {"create": "delete", "delete": "create"}


async def undo_once(undos: dict[str, Run], req: Undo, emit: Emit, now: Callable[[], int]) -> dict:
    """Undo ``req.stored`` once, keeping its run in ``undos`` by receipt id. Raises when the plan
    can't be reverted or the window has closed."""
    rid = req.stored.receipt["id"]
    prior = undos.get(rid)
    if prior is not None:
        return replay_of(await outcome(prior, "undo"), req.id)
    _check_undoable(req.stored, now())
    # Stored before revert starts, so a synchronous raise from `plan.revert` can clear it (#187).
    run = asyncio.ensure_future(_revert_once(undos, req, emit, now))
    undos[rid] = run
    forget_if_cancelled(run, lambda: forget(undos, rid, run))
    return await outcome(run, "undo")


def _check_undoable(stored: StoredReceipt, now: int) -> None:
    """Raises unless the receipt's plan can be reverted, and its undo window is still open at ``now``."""
    receipt = stored.receipt
    if not receipt["undo"] or stored.plan.revert is None:
        raise YeaError("forbidden", "this action is irreversible")
    if now > receipt["undo"]["until"]:
        raise YeaError("expired", f"the undo window closed at {_iso(receipt['undo']['until'])}")


async def _revert_once(undos: dict[str, Run], req: Undo, emit: Emit, now: Callable[[], int]) -> dict:
    """The undo receipt, or the ERROR reply for a failed revert, which frees the receipt to be undone
    again. A revert cut off is in doubt instead, and stays kept so it never runs again (runs.py)."""
    try:
        return await _revert(req, emit, now)
    except asyncio.CancelledError:
        return error_reply(req.id, in_doubt("undo"))
    except Exception as e:
        undos.pop(req.stored.receipt["id"], None)
        return error_reply(req.id, e)


async def _revert(req: Undo, emit: Emit, now: Callable[[], int]) -> dict:
    """Reverse a receipt's effects and issue the undo receipt; raises what ``revert`` raises."""
    stored, re = req.stored, req.id
    receipt = stored.receipt

    def progress(message: str, pct: float | None, _data: Any) -> None:
        emit(event_frame(re, message, pct))

    # _check_undoable has refused a plan without `revert`.
    await _call(stored.plan.revert, CommitCtx(req.principal, progress, stored.result))
    undo = {
        "id": random_id("r"), "proposal": receipt["proposal"], "capability": receipt["capability"],
        "summary": receipt["summary"], "at": now(), "effects": [_inverse(e) for e in receipt["effects"]],
        "undo": None, "undoes": receipt["id"],
    }
    return reply_frame(re, "RECEIPT", {"receipt": undo})


def _inverse(e: dict) -> dict:
    """The effect an undo receipt reports for reversing ``e``. An update swaps its sides; one the
    original left out stays left out, never null (§4.5)."""
    op = e.get("op")
    if op == "update":
        swapped = {k: v for k, v in e.items() if k not in ("from", "to")}
        if "to" in e:
            swapped["from"] = e["to"]
        if "from" in e:
            swapped["to"] = e["from"]
        return swapped
    if op == "send":
        return {"op": "other", "target": e["target"], "detail": "cannot unsend; follow-up sent if supported"}
    return {**e, "op": _INVERSE.get(op, "other")}
