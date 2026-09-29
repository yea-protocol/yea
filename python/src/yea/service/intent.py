"""INTENT: plans become proposals, and an auto INTENT may commit in one round trip (SPEC §4.3, §4.3.1)."""

from __future__ import annotations

import asyncio
from typing import Any

from .._json import proposal_hash
from ..budget import fit
from ..errors import YeaError, fix
from ..grants import GrantContext, Verification, verify_grant
from ..keys import verify_proof
from ..risk import resolve_risk
from ..uses import check_uses
from ..validate import validate_params
from .authorize import _checked, authorize
from .execute import execute
from .plan import _UNSET, Clarification, Ctx
from .replies import (
    error_reply,
    params_of,
    reply_frame,
    request_grants,
    unknown_capability,
    verified_key,
)
from .state import ServiceState, _IntentDef, _StoredProposal
from .sweep import sweep
from .util import DAY, Emit, _call, random_id

AUTO_MEMORY = 900  # seconds past max(arrival, proof.ts) a (key, frame id) auto INTENT is remembered (§4.3.1)


async def on_intent(state: ServiceState, frame: dict, budget: int, emit: Emit) -> dict:
    name = frame.get("capability")
    d = state.intents.get(name) if isinstance(name, str) else None
    if d is None:
        raise unknown_capability(state, name, "intent")
    params = params_of(frame)
    validate_params(d.params, params)
    auto = frame.get("auto") is True
    auth = await authorize(state, frame, "INTENT", name, f"auto:{name}:{frame['id']}" if auto else name)
    # A repeated auto INTENT (same holder key + frame id) gets the original reply, never a
    # second commit (§4.3.1). Only proofs that authorize verified are used as keys.
    holder = verified_key(frame) if auto else None
    key = f"{holder}:{frame['id']}" if holder else None
    if key:
        now = state.now()
        prior = state.auto_seen.get(key)
        if prior and prior[1] > now:
            r = await asyncio.shield(prior[0])
            return {**r, "id": random_id("s"), "re": frame["id"], **({"replay": True} if r["kind"] == "RECEIPT" else {})}
        task = asyncio.ensure_future(plan_intent(state, d, name, frame, params, budget, emit, auth, auto))
        # Outlive every proof that could carry this id: proofs are valid for 300s around ts.
        state.auto_seen[key] = (task, max(now, frame["proof"]["ts"]) + AUTO_MEMORY)
        if len(state.auto_seen) > 10_000:
            state.auto_seen = {k: v for k, v in state.auto_seen.items() if v[1] > now}
        return await asyncio.shield(task)
    return await plan_intent(state, d, name, frame, params, budget, emit, auth, auto)


async def plan_intent(
    state: ServiceState, d: _IntentDef, name: str, frame: dict, params: dict, budget: int, emit: Emit,
    auth: Verification | None, auto: bool,
) -> dict:
    try:
        principal = auth.principal if auth else None
        requester = verified_key(frame)
        goal = frame.get("goal") if isinstance(frame.get("goal"), str) else None
        out = await _call(d.plan, Ctx(params, principal, goal))
        if isinstance(out, Clarification):
            return reply_frame(frame["id"], "CLARIFY", {"question": out.question, "options": out.options})
        plans = list(out) if isinstance(out, (list, tuple)) else [out]
        if not plans:
            raise YeaError("not_found", "no way to satisfy this intent", fix=[fix("relax the constraints and try again")])
        now = state.now()
        proposals = []
        for plan in plans:
            window = (plan.undo_window or DAY) if plan.revert else None
            p: dict[str, Any] = {
                "id": random_id("p"),
                "capability": name,
                "summary": plan.summary,
                "effects": plan.effects,
                "risk": resolve_risk("low", plan.risk, d.risk),  # an unknown risk fails the INTENT
                "undo": None if window is None else {"window": window},
                "expires": -(-(now + (plan.expires_in or state.proposal_ttl)) // 60) * 60,  # whole minutes
            }
            uses = check_uses(plan.uses)
            if uses is not None:
                p["uses"] = uses
            if plan.data is not _UNSET:
                p["data"] = plan.data
            p["hash"] = proposal_hash(p)
            state.proposals[p["id"]] = _StoredProposal(p, plan, principal, requester)
            proposals.append(p)
        sweep(state, now)
        if auto:
            commit_auth = auto_auth(state, frame, proposals[0], principal)
            if commit_auth:
                out = await execute(state, proposals[0]["id"], commit_auth, frame["id"], emit)
                return fit({**out, "auto": True}, budget, state.handles, requester) if out["kind"] == "RECEIPT" else out
        return fit(reply_frame(frame["id"], "PROPOSALS", {"proposals": proposals}), budget, state.handles, requester)
    except Exception as e:  # noqa: BLE001 — also reached from a cached auto task
        return error_reply(frame["id"], e)


def auto_auth(state: ServiceState, frame: dict, proposal: dict, principal: str | None) -> Verification | None:
    """A grant (from ``principal``, when set) that authorizes COMMIT of ``proposal``
    outright, if the proposal is undoable."""
    grants = request_grants(frame)
    if not proposal["undo"] or not grants:
        return None
    now = state.now()
    if verify_proof(frame.get("proof"), state.id, "INTENT", f"auto:{proposal['capability']}:{frame['id']}", now):
        return None
    ctx = GrantContext(state.id, "COMMIT", proposal["capability"], now, _checked(proposal), state.spent)
    for g in grants:
        c = verify_grant(g, state.trust, frame["proof"]["key"], ctx)
        if c.ok and (principal is None or c.principal == principal):
            return c
    return None
