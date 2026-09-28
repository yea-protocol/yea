"""UNDO: reverting a receipt within its window, once, for its own principal (SPEC §4.6)."""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, Any

from ..budget import fit
from ..errors import YeaError
from .authorize import authorize
from .plan import CommitCtx
from .replies import error_reply, reply_frame
from .util import Emit, _call, _iso, _json_str, random_id

if TYPE_CHECKING:
    from . import Service


_INVERSE = {"create": "delete", "delete": "create"}


def _inverse(e: dict) -> dict:
    op = e.get("op")
    if op == "update":
        return {**e, "from": e.get("to"), "to": e.get("from")}
    if op == "send":
        return {"op": "other", "target": e["target"], "detail": "cannot unsend; follow-up sent if supported"}
    return {**e, "op": _INVERSE.get(op, "other")}


async def on_undo(svc: Service, frame: dict, budget: int, emit: Emit) -> dict:
    rid = frame.get("receipt")
    stored = svc._receipts.get(rid) if isinstance(rid, str) else None
    if stored is None or stored.receipt.get("undoes"):
        raise YeaError("not_found", f"no undoable receipt {_json_str(rid)}")
    auth = await authorize(svc, frame, "UNDO", stored.receipt["capability"], rid)
    assert auth is not None
    if auth.principal != stored.principal:
        raise YeaError("forbidden", "only the principal who committed this can undo it")
    if stored.undone is not None:
        prior = await asyncio.shield(stored.undone)
        # Every waiter gets its own `re`, whether the shared attempt succeeded or failed.
        return {**prior, "id": random_id("s"), "re": frame["id"], **({"replay": True} if prior["kind"] == "RECEIPT" else {})}
    receipt, plan = stored.receipt, stored.plan
    if not receipt["undo"] or plan.revert is None:
        raise YeaError("forbidden", "this action is irreversible")
    if svc.now() > receipt["undo"]["until"]:
        raise YeaError("expired", f"the undo window closed at {_iso(receipt['undo']['until'])}")
    re = frame["id"]

    def progress(message: str, pct: float | None, _data: Any) -> None:
        emit(reply_frame(re, "EVENT", {"message": message, **({"progress": pct} if pct is not None else {})}))

    async def run() -> dict:
        try:
            await _call(plan.revert, CommitCtx(auth.principal, progress, stored.result))
            undo = {
                "id": random_id("r"), "proposal": receipt["proposal"], "capability": receipt["capability"],
                "summary": receipt["summary"], "at": svc.now(), "effects": [_inverse(e) for e in receipt["effects"]],
                "undo": None, "undoes": receipt["id"],
            }
            return reply_frame(re, "RECEIPT", {"receipt": undo})
        except Exception as e:  # noqa: BLE001
            stored.undone = None
            return error_reply(re, e)

    stored.undone = asyncio.ensure_future(run())
    out = await asyncio.shield(stored.undone)
    return fit(out, budget, svc.handles, frame["proof"]["key"]) if out["kind"] == "RECEIPT" else out
