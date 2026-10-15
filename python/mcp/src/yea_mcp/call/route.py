"""The adapter: ``run_job`` reads the request (who is calling, the policy, whether the client can ask,
the state and answer a retry carries), lets the SDK's job call session decide the round, and turns
its outcome into an MCP result. The session owns the order that keeps a call safe; ``run.py``
applies the chosen plan (step 11)."""

from __future__ import annotations

import time
from collections.abc import Awaitable, Callable
from typing import Any

from yea.job_call import JobCall, JobTool, Outcome, Retry, job_call
from yea.text import printable

from ..ask import answer_of, ask_in_call, can_ask, input_required, is_modern, parse_state
from ..render import clarify_result, consent_result, preview_result
from ..result import NOTHING_RAN, error_result
from .model import Call, JobDef, Req, Result, Yea
from .prepare import caller_of, policy_for
from .run import _run_plan


async def run_job(y: Yea, job: JobDef, input: dict, preview: bool, req: Req,
                  plan: Callable[[], Awaitable[Any]]) -> Result:
    """Anything unexpected before ``apply()`` runs nothing."""
    try:
        call = Call(y, job, input, req, caller_of(y, req.rctx), int(time.time()), plan)
        return await _round(call, preview, None if preview else _retry_of(req))
    except Exception as e:  # noqa: BLE001 — nothing has been applied yet
        return error_result([f"✗ {printable(str(e))}; {NOTHING_RAN}"])


def _retry_of(req: Req) -> Retry | None:
    """Step 5: a first call (None), or a retry carrying our state and the answer. Anything else
    raises, and the call is refused."""
    kind, value = parse_state(req.state)
    if kind == "fresh":
        return None
    if kind == "foreign":
        raise ValueError(value)
    return Retry(value, answer_of(req.responses))


def _facts(call: Call, preview: bool) -> JobCall:
    """The session's facts for this round: the policy and the clock as they are now."""
    job = call.job
    return JobCall(JobTool(job.name, job.risk, job.revert, job.confirm_with), call.input, call.plan, call.sub,
                   call.now, policy_for(call.y), can_ask(call.req.session), preview, call.y.principal.why)


async def _round(call: Call, preview: bool, retry: Retry | None) -> Result:
    return await _result_of(call, await job_call(_facts(call, preview), call.y.store, retry))


async def _result_of(call: Call, o: Outcome) -> Result:
    """The MCP result for a round's outcome."""
    if o.kind == "clarify" and o.clarification is not None:
        return clarify_result(o.clarification)
    if o.kind == "preview":
        return preview_result(o.plans, call.job.own_results_are_errors())
    if o.kind == "run" and o.plan is not None:
        return await _run_plan(call, o.plan, o.held, o.how or "approved")
    if o.kind == "ask" and o.form is not None and o.state is not None and o.otherwise is not None:
        return await _ask(call, o.form, o.state, o.otherwise)
    if o.kind == "consent-codes":
        return consent_result(o.why or "", o.plans, o.codes, o.unavailable)
    if o.again:
        return error_result([f"✗ {o.why}; {NOTHING_RAN}. Call the tool again to ask again."])
    return error_result([f"✗ {o.why}; {NOTHING_RAN}"])


async def _ask(call: Call, form: dict, state: dict, otherwise: Callable[[], Outcome]) -> Result:
    """Step 8, per era: a 2026 client gets the form and our state, which the SDK seals; a 2025
    client is asked inside the call, and its answer is the next round, with the clock, the policy
    and the plans as a 2026 retry (or TypeScript's re-run) would see them."""
    if is_modern(call.req.protocol_version):
        return input_required(form, state)
    answer = await ask_in_call(call.req.session, call.req.request_id, form)
    if answer is None:  # the client can't be reached from here
        return await _result_of(call, otherwise())
    later = Call(call.y, call.job, call.input, call.req, call.sub, int(time.time()), call.plan)
    return await _round(later, False, Retry(state, answer))
