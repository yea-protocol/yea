"""Running a proposal's apply at most once, with its totals reserved first and released on failure (SPEC §6.3)."""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, Any

from ..errors import YeaError
from ..grants import Verification
from ..uses import limit_value, same_unit, value
from .authorize import consent_request
from .plan import CommitCtx
from .replies import error_reply, reply_frame
from .state import _StoredReceipt
from .util import Emit, _call, random_id

if TYPE_CHECKING:
    from . import Service


async def execute(svc: Service, pid: str, auth: Verification, re: str, emit: Emit) -> dict:
    """Run a proposal's ``apply`` at most once; concurrent and later commits share the result.
    Spend is re-checked and reserved before anything can yield, and released on failure."""
    stored = svc._proposals[pid]
    proposal, plan = stored.proposal, stored.plan
    held, over = reserve(svc, proposal, auth)
    if held is None:
        return error_reply(re, YeaError(
            "consent_required",
            f"{over} would pass a total limit (other commits are in flight); your principal must approve this exact proposal",
            consent=consent_request(svc, proposal, auth.principal),
        ))

    def progress(message: str, pct: float | None, data: Any) -> None:
        body: dict[str, Any] = {"message": message}
        if pct is not None:
            body["progress"] = pct
        if data is not None:
            body["data"] = data
        emit(reply_frame(re, "EVENT", body))

    async def run() -> dict:
        try:
            result = await _call(plan.apply, CommitCtx(auth.principal, progress))
            at = svc.now()
            receipt: dict[str, Any] = {
                "id": random_id("r"), "proposal": pid, "capability": proposal["capability"], "summary": proposal["summary"],
                "at": at, "effects": proposal["effects"],
                "undo": {"until": at + proposal["undo"]["window"]} if proposal["undo"] else None,
            }
            if "uses" in proposal:
                receipt["uses"] = proposal["uses"]
            if result is not None:
                receipt["result"] = result
            svc._receipts[receipt["id"]] = _StoredReceipt(receipt, plan, result, auth.principal)
            return reply_frame(re, "RECEIPT", {"receipt": receipt})
        except Exception as e:  # noqa: BLE001
            for key, v in held:  # release the reservation
                svc._spent[key] -= v
            svc._commits.pop(pid, None)  # failed commits may be retried
            return error_reply(re, e)

    task = asyncio.ensure_future(run())
    svc._commits[pid] = task
    return await asyncio.shield(task)


def reserve(svc: Service, proposal: dict, auth: Verification) -> tuple[list[tuple[tuple[str, str], int]] | None, str | None]:
    """Reserve the proposal's quantities against every ``total`` limit of the authorizing grant
    (§6.3), before anything can yield: what was reserved, or None (reserving nothing) and the
    measure that would pass its limit."""
    uses = proposal.get("uses") or {}
    held: dict[tuple[str, str], int] = {}
    for bid, limit in auth.total_limits():
        q = uses.get(limit["of"])
        if q is None or not same_unit(q, limit):
            continue  # not reported; a unit mismatch already failed the grant check
        key = (bid, limit["of"])
        held[key] = value(q)  # one reservation per (block, measure), however many limits name it
        if svc._spent.get(key, 0) + held[key] > limit_value(limit):
            return None, limit["of"]
    for key, v in held.items():
        svc._spent[key] = svc._spent.get(key, 0) + v
    return list(held.items()), None
