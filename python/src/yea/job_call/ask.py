"""Asking the person (SPEC-approval §3, §4, §6): the form and the state that goes round the client
when the client can take a form, and otherwise the plans with a consent code for each."""

from __future__ import annotations

from ..approval import HashedPlan, build_form, input_hash, job_consent_code, new_state
from ..approval.decision import ruled_out
from .outcome import Outcome, Round


def ask(r: Round, why: str, round: int) -> Outcome:
    """Ask with a form if the client can take one and a plan can be offered; else consent codes."""
    call = r.call
    form = build_form(r.plans, why, call.policy, r.phrase_for) if call.can_ask else None
    if form is None:
        return consent_codes(r, why, r.plans)
    state = new_state(call.tool.name, input_hash(call.input), call.sub, form["offered"], round, call.now)
    return Outcome("ask", form=form, state=state, otherwise=lambda: consent_codes(r, why, r.plans))


def consent_codes(r: Round, why: str, plans: list[HashedPlan]) -> Outcome:
    """Nothing runs: the plans, and a consent code for each one the policy doesn't deny (§6). Any
    store gets codes: a consent ``yea approve`` can't save where the server reads comes back on the
    call."""
    call = r.call
    if not call.policy.principal:
        return Outcome("consent-codes", why, plans, unavailable=call.unpinned or "no principal key is pinned")
    codes = [{"planHash": hp.plan_hash,
              "code": job_consent_code(call.policy.server_key or "", call.policy.principal, call.input, hp,
                                       r.phrase_for(hp), call.now)}
             for hp in plans if _not_denied(hp, r)]
    return Outcome("consent-codes", why, plans, codes=codes)


def _not_denied(hp: HashedPlan, r: Round) -> bool:
    out = ruled_out(hp, r.call.policy)
    return out is None or out.kind != "denied"
