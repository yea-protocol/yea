"""INTENT: plans become proposals, and an auto INTENT may commit in one round trip (SPEC §4.3, §4.3.1)."""

from __future__ import annotations

import asyncio
from typing import Any

from .._json import proposal_hash
from ..budget import fit
from ..errors import YeaError, fix
from ..risk import resolve_risk
from ..uses import check_uses
from .execute import execute
from .plan import _UNSET, Clarification, Ctx
from .replies import error_reply, reply_frame
from .state import ServiceState, _StoredProposal
from .sweep import sweep
from .util import DAY, Emit, _call, random_id
from .verified_request import VerifiedIntent

AUTO_MEMORY = 900  # seconds past max(arrival, proof.ts) a (key, frame id) auto INTENT is remembered (§4.3.1)


async def on_intent(state: ServiceState, req: VerifiedIntent, emit: Emit) -> dict:
    # A repeated auto INTENT (same verified holder key + frame id) gets the original reply, never a
    # second commit (§4.3.1).
    replay = req.auto.replay if req.auto else None
    if replay:
        key, proof_ts = replay
        now = state.now()
        prior = state.auto_seen.get(key)
        if prior and prior[1] > now:
            r = await asyncio.shield(prior[0])
            return {**r, "id": random_id("s"), "re": req.id, **({"replay": True} if r["kind"] == "RECEIPT" else {})}
        task = asyncio.ensure_future(plan_intent(state, req, emit))
        # Outlive every proof that could carry this id: proofs are valid for 300s around ts.
        state.auto_seen[key] = (task, max(now, proof_ts) + AUTO_MEMORY)
        if len(state.auto_seen) > 10_000:
            state.auto_seen = {k: v for k, v in state.auto_seen.items() if v[1] > now}
        return await asyncio.shield(task)
    return await plan_intent(state, req, emit)


async def plan_intent(state: ServiceState, req: VerifiedIntent, emit: Emit) -> dict:
    try:
        principal = req.principal
        out = await _call(req.d.plan, Ctx(req.params, principal, req.goal))
        if isinstance(out, Clarification):
            return reply_frame(req.id, "CLARIFY", {"question": out.question, "options": out.options})
        plans = list(out) if isinstance(out, (list, tuple)) else [out]
        if not plans:
            raise YeaError("not_found", "no way to satisfy this intent", fix=[fix("relax the constraints and try again")])
        now = state.now()
        proposals = []
        for plan in plans:
            window = (plan.undo_window or DAY) if plan.revert else None
            p: dict[str, Any] = {
                "id": random_id("p"),
                "capability": req.capability,
                "summary": plan.summary,
                "effects": plan.effects,
                "risk": resolve_risk("low", plan.risk, req.d.risk),  # an unknown risk fails the INTENT
                "undo": None if window is None else {"window": window},
                "expires": -(-(now + (plan.expires_in or state.proposal_ttl)) // 60) * 60,  # whole minutes
            }
            uses = check_uses(plan.uses)
            if uses is not None:
                p["uses"] = uses
            if plan.data is not _UNSET:
                p["data"] = plan.data
            p["hash"] = proposal_hash(p)
            # Only the holder key of a verified proof may commit it, and replies are for it alone.
            state.proposals[p["id"]] = _StoredProposal(p, plan, principal, req.holder)
            proposals.append(p)
        sweep(state, now)
        commit_auth = req.auto.grant(proposals[0]) if req.auto else None
        if commit_auth:
            out = await execute(state, proposals[0]["id"], commit_auth, req.id, emit)
            return fit({**out, "auto": True}, req.budget, state.handles, req.holder) if out["kind"] == "RECEIPT" else out
        return fit(reply_frame(req.id, "PROPOSALS", {"proposals": proposals}), req.budget, state.handles, req.holder)
    except Exception as e:  # noqa: BLE001 — also reached from a cached auto task
        return error_reply(req.id, e)
