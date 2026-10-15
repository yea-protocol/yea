"""A job call's first round (SPEC-approval §2, §5, §6): a consent from ``yea approve``, consumed;
else the policy decision, reserving after deciding; else ask."""

from __future__ import annotations

from ..approval import consent_for, decide, reserve_all, spent
from .ask import ask
from .outcome import Outcome, Round


async def first_round(r: Round) -> Outcome:
    """A stored consent runs its plan; else the policy decides; else ask."""
    call = r.call
    approved = await consent_for(r.plans, r.store, call.policy, call.now)
    if approved is not None:
        return Outcome("run", plan=approved, how="approved")
    amounts = await spent(r.store, call.policy)
    d = decide(r.plans, call.policy, lambda k: amounts.get(k, 0), call.now)
    if d.kind == "run" and d.plan is not None:
        # Reserved after deciding, all or nothing: a limit another call filled since asks instead.
        held = await reserve_all(r.store, d.reserve)
        if held is None:
            return ask(r, "a limit filled up while this call was being decided", 1)
        return Outcome("run", plan=d.plan, how="auto", held=held)
    if d.kind == "denied":
        return Outcome("refuse", d.why)
    if d.kind == "nothing":
        return Outcome("refuse", "no plans")
    return ask(r, d.why or "approval needed", 1)
