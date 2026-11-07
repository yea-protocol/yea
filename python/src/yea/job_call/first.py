"""A job call's first round (SPEC-approval §2, §5, §6): a consent on the call, which alone decides;
else a consent from ``yea approve`` in the store, consumed; else the policy decision, reserving after
deciding; else ask."""

from __future__ import annotations

from ..approval import consent_for, decide, reserve_all, spent
from .ask import ask
from .carried import carried_round
from .outcome import Outcome, Round


async def first_round(r: Round) -> Outcome:
    """A consent on the call runs its plan or asks again; else a stored consent runs its plan; else
    the policy decides; else ask."""
    call = r.call
    if call.consent is not None:
        return await carried_round(r, call.consent)
    stored = await consent_for(r.plans, r.store, r.store_id, call.policy, call.now, r.phrase_for)
    if stored.plan is not None:
        return Outcome("run", plan=stored.plan, how="approved")
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
    return ask(r, stored.note or d.why or "approval needed", 1)
