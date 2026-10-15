"""A retry with the person's answer (SPEC-approval §5): the state checked and its nonce consumed,
whatever the answer, before the answer is judged against the plans recomputed this round."""

from __future__ import annotations

from ..approval import check_state, input_hash, judge_answer
from ..approval.decision import out_of_band_reason
from .ask import ask, consent_codes
from .outcome import Outcome, Retry, Round

# One message for every reason a state can't be used (§5 step 1).
INVALID_STATE = "this approval is invalid, expired, already used, or for another call"


async def answer_round(r: Round, retry: Retry) -> Outcome:
    """Check and consume the state, then judge the answer against the recomputed plans."""
    call = r.call
    state = check_state(retry.state, call.tool.name, input_hash(call.input), call.sub, call.now)
    if state is None or not await r.store.consume_once(state["nonce"], state["exp"]):
        return Outcome("refuse", INVALID_STATE, again=True)
    v = judge_answer(state, retry.answer, r.plans, call.policy, r.phrase_for)
    if v.kind == "run" and v.plan is not None:
        return Outcome("run", plan=v.plan, how="approved")
    if v.kind == "ask-again" and v.round is not None:
        return ask(r, v.why or "ask again", v.round)
    if v.kind == "out-of-band" and v.plan is not None:
        return consent_codes(r, out_of_band_reason(v.plan), [v.plan])
    if v.kind == "not-approved":
        return Outcome("refuse", "not approved")
    return Outcome("refuse", v.why)
