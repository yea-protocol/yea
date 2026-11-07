"""INTENT: plans become proposals for the commit ledger, and an auto INTENT may commit in one round
trip (SPEC §4.3, §4.3.1). Like ts/src/service/intent.ts."""

from __future__ import annotations

from typing import Any

from .._json import proposal_hash
from ..budget import fit
from ..errors import YeaError, fix
from ..risk import resolve_risk
from ..undo_window import undo_window_of
from ..uses import check_uses
from .commit_ledger import Answer, StoredProposal
from .plan import _UNSET, Clarification, Ctx, Plan
from .replies import error_reply, reply_frame
from .state import ServiceState
from .util import DAY, Emit, _call, random_id
from .verified_request import VerifiedIntent


async def on_intent(state: ServiceState, req: VerifiedIntent, emit: Emit) -> dict:
    """A repeated auto INTENT (same verified holder key and frame id) gets the original reply, never a
    second commit (§4.3.1)."""
    replay = req.auto.replay if req.auto else None
    if replay:
        return await state.ledger.answer_once(replay, req.id, lambda: plan_intent(state, req, emit))
    return await plan_intent(state, req, emit)


def _undo_of(plan: Plan) -> dict | None:
    """A proposal's ``undo`` (SPEC §5.1): with a ``revert``, the plan's window, a day when it leaves
    it out. A value that isn't an undo window, None included, makes the proposal irreversible."""
    window = undo_window_of(DAY if plan.undo_window is _UNSET else plan.undo_window)
    return {"window": window} if plan.revert and window is not None else None


async def plan_intent(state: ServiceState, req: VerifiedIntent, emit: Emit) -> dict:
    try:
        out = await _call(req.d.plan, Ctx(req.params, req.principal, req.goal))
        if isinstance(out, Clarification):
            return reply_frame(req.id, "CLARIFY", {"question": out.question, "options": out.options})
        plans = list(out) if isinstance(out, (list, tuple)) else [out]
        if not plans:
            raise YeaError("not_found", "no way to satisfy this intent", fix=[fix("relax the constraints and try again")])
        now = state.now()
        # Only the holder key of a verified proof may commit it, and replies are for it alone.
        stored = [StoredProposal(_propose(state, req, plan, now), plan, req.principal, req.holder) for plan in plans]
        state.ledger.propose(stored)
        committed = await _auto_commit(state, req, stored[0], emit)
        if committed:
            return committed
        proposals = [s.proposal for s in stored]
        return fit(reply_frame(req.id, "PROPOSALS", {"proposals": proposals}), req.budget, state.handles, req.holder)
    except Exception as e:  # noqa: BLE001 — also reached from a kept auto reply
        return error_reply(req.id, e)


def _propose(state: ServiceState, req: VerifiedIntent, plan: Plan, now: int) -> dict:
    """Turn a plan into a hashed proposal, filling defaults and rounding expiry up to the minute."""
    p: dict[str, Any] = {
        "id": random_id("p"),
        "capability": req.capability,
        "summary": plan.summary,
        "effects": plan.effects,
        "risk": resolve_risk("low", plan.risk, req.d.risk),  # an unknown risk fails the INTENT
        "undo": _undo_of(plan),
        "expires": -(-(now + (plan.expires_in or state.proposal_ttl)) // 60) * 60,  # whole minutes
    }
    uses = check_uses(plan.uses)
    if uses is not None:
        p["uses"] = uses
    if plan.data is not _UNSET:
        p["data"] = plan.data
    p["hash"] = proposal_hash(p)
    return p


async def _auto_commit(state: ServiceState, req: VerifiedIntent, stored: StoredProposal, emit: Emit) -> dict | None:
    """Commit an auto INTENT's first proposal if the ledger admits it outright; None leaves it a
    proposal, as does an INTENT with no ``admit`` (no auto, or no principal: §4.3.1, #287)."""
    admit = req.auto.admit if req.auto else None
    if admit is None:
        return None
    out = await state.ledger.auto_commit(stored, admit, Answer(req.id, emit))
    if out is not None and out["kind"] == "RECEIPT":
        return fit({**out, "auto": True}, req.budget, state.handles, req.holder)
    return out
