"""The routine: ``run_job`` takes a call through the steps in order, and routes it to run, ask, judge an
answer, or fail closed (steps 1–10; ``run.py`` does step 11)."""

from __future__ import annotations

import time
from collections.abc import Awaitable, Callable
from typing import Any

import mcp_types as t
from yea.approval import (
    HashedPlan,
    build_form,
    check_state,
    consent_for,
    decide,
    input_hash,
    job_consent_code,
    judge_answer,
    new_state,
    reserve_all,
    spent,
)
from yea.service import Clarification
from yea.text import printable

from ..ask import (
    answer_of,
    ask_in_call,
    can_ask,
    input_required,
    is_modern,
    parse_state,
)
from ..render import clarify_result, consent_result, error_result, preview_result
from .model import BAD_STATE, NOTHING_RAN, Call, JobDef, Req, Result, Yea
from .prepare import caller_of, hash_plans, is_memory_store, policy_for
from .run import _run_plan


async def run_job(y: Yea, job: JobDef, input: dict, preview: bool, req: Req,
                  plan: Callable[[], Awaitable[Any]]) -> Result:
    """Steps 1–11. Anything unexpected before ``apply()`` runs nothing."""
    try:
        sub = caller_of(y, req.rctx)
        input_hash(input)  # step 1: canonical JSON, so integer-only numbers
        policy = policy_for(y)
        if job.name in policy.deny:  # step 2: a denied tool shows nothing, not even a preview
            return error_result([f"✗ your policy never allows {job.name}; {NOTHING_RAN}"])
        out = await plan()
        if isinstance(out, Clarification):
            return clarify_result(out)
        if not isinstance(out, (list, tuple)):
            raise TypeError("a job's plan function must return a list of plans or clarify(...)")
        if not out:
            return error_result([f"✗ {job.name} has no way to do this; {NOTHING_RAN}"])
        call = Call(y, job, input, req, sub, int(time.time()), policy, hash_plans(job, input, list(out)), plan)
        if preview:
            return preview_result(call.plans, job.own_results_are_errors())
        return await _route(call)
    except Exception as e:  # noqa: BLE001 — nothing has been applied yet
        return error_result([f"✗ {printable(str(e))}; {NOTHING_RAN}"])


async def _route(call: Call) -> Result:
    """Step 5: a first call, or a retry carrying our state. Anything else is refused."""
    kind, value = parse_state(call.req.state)
    if kind == "fresh":
        return await _fresh(call)
    if kind == "foreign":
        raise ValueError(value)
    return await _answer(call, value, answer_of(call.req.responses))


async def _fresh(call: Call) -> Result:
    """Steps 6–8 on a first call: a consent, the policy, or ask."""
    approved = await consent_for(call.plans, call.y.store, call.policy, call.now)
    if approved is not None:
        return await _run_plan(call, approved, [], "approved")
    amounts = await spent(call.y.store, call.policy)
    d = decide(call.plans, call.policy, lambda k: amounts.get(k, 0), call.now)
    if d.kind == "run" and d.plan is not None:
        held = await reserve_all(call.y.store, d.reserve)
        if held is None:
            return await _ask(call, "a limit filled up while this call was being decided", 1)
        return await _run_plan(call, d.plan, held, "auto")
    if d.kind == "denied":
        return error_result([f"✗ {d.why}; {NOTHING_RAN}"])
    if d.kind == "nothing":
        return error_result([f"✗ no plans; {NOTHING_RAN}"])
    return await _ask(call, d.why or "approval needed", 1)


async def _ask(call: Call, why: str, round: int) -> Result:
    """Step 8: a form if the client can take one, asked per era; else step 9."""
    form = build_form(call.plans, why, call.policy, _phrase_for(call)) if can_ask(call.req.session) else None
    if form is None:
        return await _fail_closed(call, why, call.plans)
    state = new_state(call.job.name, input_hash(call.input), call.sub, form["offered"], round, call.now)
    if is_modern(call.req.protocol_version):
        return input_required(form, state)
    answer = await ask_in_call(call.req.session, call.req.request_id, form)
    if answer is None:  # the client can't be reached from here
        return await _fail_closed(call, why, call.plans)
    return await _answer(await _replanned(call), state, answer)


async def _replanned(call: Call) -> Call:
    """After a 2025 in-call answer: the clock and the plans as they are now, as a 2026 retry (or
    TypeScript's re-run) would see them. Plans that can't be recomputed count as changed."""
    try:
        out = await call.plan()
        plans = hash_plans(call.job, call.input, list(out)) if isinstance(out, (list, tuple)) else []
    except Exception:  # noqa: BLE001
        plans = []
    policy = policy_for(call.y)  # a deny added while the person was reading counts; a broken file refuses
    return Call(call.y, call.job, call.input, call.req, call.sub, int(time.time()), policy, plans, call.plan)


async def _fail_closed(call: Call, why: str, plans: list[HashedPlan]) -> t.CallToolResult:
    """Step 9: nothing runs; the plans and a consent code for each, for ``yea approve``."""
    if call.y.principal.key is None:
        return consent_result(why, plans, [], call.y.principal.why)
    if is_memory_store(call.y.store):
        return consent_result(why, plans, [], "this server keeps approvals in memory, where `yea approve` can't "
                                              "reach them")
    phrase = _phrase_for(call)
    codes = [{"planHash": hp.plan_hash,
              "code": job_consent_code(call.y.service_id, call.y.principal.key, call.input, hp, phrase(hp), call.now)}
             for hp in plans if hp.tool not in call.policy.deny]
    return consent_result(why, plans, codes, None)


async def _answer(call: Call, raw: Any, answer: dict) -> Result:
    """Step 10: check and consume the state, then judge the answer against the recomputed plans."""
    state = check_state(raw, call.job.name, input_hash(call.input), call.sub, call.now)
    if state is None or not await call.y.store.consume_once(state["nonce"], state["exp"]):
        return error_result([f"✗ {BAD_STATE}"])
    v = judge_answer(state, answer, call.plans, call.policy, _phrase_for(call))
    if v.kind == "run" and v.plan is not None:
        return await _run_plan(call, v.plan, [], "approved")
    if v.kind == "ask-again" and v.round is not None:
        return await _ask(call, v.why or "ask again", v.round)
    if v.kind == "out-of-band" and v.plan is not None:
        return await _fail_closed(call, f"risk is {v.plan.risk}, which needs approval outside the chat", [v.plan])
    if v.kind == "not-approved":
        return error_result([f"✗ not approved; {NOTHING_RAN}"])
    return error_result([f"✗ {v.why}; {NOTHING_RAN}"])


def _phrase_for(call: Call) -> Callable[[HashedPlan], str]:
    def phrase(hp: HashedPlan) -> str:
        p = call.job.confirm_with(hp, call.input) if call.job.confirm_with else ""
        if not isinstance(p, str):
            raise TypeError("confirm_with() must return a string")
        return p
    return phrase
