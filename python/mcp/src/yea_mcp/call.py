"""How a job call runs (SPEC-mcp-py, "How a call runs", steps 1–11). Every decision comes from the
SDK core (``decide``, ``build_form``, ``judge_answer``, ``consent_for``); this file only orders
them and turns their answers into MCP results. The job wrapper and the guard middleware share it."""

from __future__ import annotations

import inspect
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

import mcp_types as t
from mcp_types.methods import is_input_required
from pydantic_core import to_jsonable_python
from yea import Plan
from yea.approval import (
    HashedPlan, Policy, Tightening, build_form, check_state, consent_for, decide, input_hash, job_consent_code, judge_answer,
    load_policy, new_receipt_id, new_state, plan_hash, release_all, reserve_all, settle_all, spent,
)
from yea.service import Clarification
from yea.store import ApprovalStore, Reservation
from yea.text import printable
from yea.uses import check_uses

from .ask import answer_of, ask_in_call, can_ask, input_required, is_modern, parse_state
from .keys import Pinned, has_total, read_policy, read_tightening_for
from .render import clarify_result, consent_result, error_result, preview_result, receipt_result

Result = Any  # a CallToolResult, an InputRequiredResult, or (guard) the original's wire mapping

NOTHING_RAN = "nothing was run"
BAD_STATE = ("this approval is invalid, expired, already used, or for another call; nothing was run. "
             "Call the tool again to ask again.")


@dataclass
class Yea:
    """The one approval context per process that ``yea()`` creates."""

    name: str
    transport: str
    store: ApprovalStore
    shared_memory: bool  # a MemoryStore without a promise that one process serves every request
    principal: Pinned
    policy: str | None
    tighten: Any
    service_id: str
    sub: Callable[[Any], str]


def wire_failed(result: Any) -> bool:
    """``MCPServer``'s ``call_next`` hands back the wire mapping: read it structurally, assume no class."""
    if is_input_required(result):
        return True
    return result.get("isError") is True if isinstance(result, dict) else True


def wire_with_receipt(result: Any, receipt: dict) -> Any:
    return {**result, "_meta": {**(result.get("_meta") or {}), "dev.yea/receipt": receipt}}


def wire_with_note(result: Any, note: str) -> Any:
    return {**result, "content": [*(result.get("content") or []), {"type": "text", "text": note}]}


@dataclass
class JobDef:
    """A job as the routine runs it: from ``job()`` or from ``guard()``. A guard's original result
    is the SDK's own shape, so how to read it and add to it is per SDK."""

    name: str
    risk: str | None
    revert: Callable[..., Any] | None
    confirm_with: Callable[[HashedPlan, dict], str] | None
    guarded: bool = False
    own_results_are_errors: Callable[[], bool] = lambda: False
    failed: Callable[[Any], bool] = wire_failed
    with_receipt: Callable[[Any, dict], Any] = wire_with_receipt
    with_note: Callable[[Any, str], Any] = wire_with_note


@dataclass
class Req:
    """What the routine needs from the request, whichever SDK surface it came through."""

    rctx: Any  # the ServerRequestContext, which sub() gets
    session: Any
    request_id: Any
    protocol_version: str | None
    state: Any  # the plaintext request state, or None
    responses: Any  # the input responses, or None


@dataclass
class Call:
    y: Yea
    job: JobDef
    input: dict
    req: Req
    sub: str
    now: int
    policy: Policy
    plans: list[HashedPlan]
    plan: Callable[[], Awaitable[Any]]  # re-plans for each round of a 2025 in-call ask


def is_memory_store(store: Any) -> bool:
    """By name along the class's ancestry, not by class: two copies of the SDK core mean two
    MemoryStore classes, and a subclass (a counting store in tests, say) is still one."""
    return any(c.__name__ == "MemoryStore" and c.__module__.startswith("yea") for c in type(store).__mro__)


async def _maybe(v: Any) -> Any:
    return await v if inspect.isawaitable(v) else v


def caller_of(y: Yea, rctx: Any) -> str:
    """Who is calling; on HTTP an empty answer refuses the call."""
    sub = y.sub(rctx)
    if not isinstance(sub, str) or (y.transport == "http" and sub == ""):
        raise ValueError("no authenticated caller: the server's sub() returned no identity")
    return sub


def policy_for(y: Yea) -> Policy:
    """The policy for this call; raises when its totals can't be kept on this store."""
    rules = read_tightening_for(y.tighten)
    if rules.broken:  # a policy file that can't be read hides its deny list: refuse rather than guess
        raise ValueError(f"your unsigned policy can't be used ({rules.broken})")
    grant = read_policy(y.policy) if y.principal.key else None  # no pinned principal: nothing auto-runs
    if grant and y.shared_memory and has_total(grant):
        raise ValueError("the policy has a total limit, which a MemoryStore can only keep when one process "
                         "serves every request (single_process=True)")
    return load_policy(grant, y.service_id, y.principal.key, Tightening(rules.deny, rules.out_of_band))


def hash_plans(job: JobDef, input: dict, plans: list[Any]) -> list[HashedPlan]:
    out = []
    for p in plans:
        if not isinstance(p, Plan):
            raise TypeError("a job's plan function must return a list of yea.Plan, or clarify(...)")
        risk = p.risk or job.risk or "medium"
        undoable = p.undo_window is not None and job.revert is not None
        out.append(HashedPlan(job.name, p, plan_hash(job.name, input, p, risk), risk, undoable))
    return out


def _phrase_for(call: Call) -> Callable[[HashedPlan], str]:
    def phrase(hp: HashedPlan) -> str:
        p = call.job.confirm_with(hp, call.input) if call.job.confirm_with else ""
        if not isinstance(p, str):
            raise TypeError("confirm_with() must return a string")
        return p
    return phrase


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


async def _run_plan(call: Call, hp: HashedPlan, held: list[Reservation], how: str) -> Result:
    """Step 11: apply once, then settle and record the receipt. Once ``apply()`` has returned,
    nothing may say "nothing ran": a client told that would retry and run it again."""
    try:
        result = await _maybe(hp.plan.apply())
    except Exception as e:  # noqa: BLE001
        await release_all(call.y.store, held)
        approved = how == "approved"
        return error_result([f"✗ {'approved, but ' if approved else ''}{printable(hp.plan.summary)} failed: "
                             f"{printable(str(e))}; nothing changed."
                             f"{' The approval is used up: calling again asks again.' if approved else ''}"])
    if call.job.guarded and call.job.failed(result):  # a guarded tool's own error, or a request for input
        try:
            await release_all(call.y.store, held)
        except Exception:  # noqa: BLE001 — a reservation that can't be released only over-counts
            pass
        return result
    try:
        return await _recorded(call, hp, held, result, how == "auto")
    except Exception as e:  # noqa: BLE001
        return _unrecorded(call, hp, result if call.job.guarded else None, str(e))


def _receipt_for(call: Call, hp: HashedPlan, result: Any) -> dict:
    """The receipt a successful job leaves (SPEC-approval §8's job receipt)."""
    p = hp.plan
    receipt: dict[str, Any] = {"id": new_receipt_id(), "service": call.y.service_id, "proposal": hp.plan_hash,
                               "capability": hp.tool, "summary": p.summary, "at": call.now, "effects": p.effects}
    if (uses := check_uses(p.uses)) is not None:
        receipt["uses"] = uses
    receipt["undo"] = {"until": call.now + p.undo_window} if hp.undoable and p.undo_window is not None else None
    receipt |= {"tool": hp.tool, "input": call.input, "planHash": hp.plan_hash, "sub": call.sub}
    if result is not None:
        receipt["result"] = result
    return receipt


def json_safe(v: Any) -> tuple[Any, str | None]:
    """The result as plain JSON, or None and why it couldn't be (a circular or odd object)."""
    try:
        return to_jsonable_python(v, by_alias=True, exclude_none=True), None
    except (ValueError, TypeError) as e:
        return None, f"its result couldn't be turned into JSON ({e})"


async def _recorded(call: Call, hp: HashedPlan, held: list[Reservation], result: Any, auto: bool) -> Result:
    """After ``apply()`` succeeded: settle, store the receipt, and return it."""
    safe, problem = json_safe(result)
    if problem:
        await settle_all(call.y.store, held)
        return _unrecorded(call, hp, result if call.job.guarded else None, problem)
    receipt = _receipt_for(call, hp, safe)
    try:
        await settle_all(call.y.store, held)
        await call.y.store.put_receipt(receipt)
    except Exception as e:  # noqa: BLE001
        return _unrecorded(call, hp, result if call.job.guarded else safe, str(e))
    if call.job.guarded:
        return call.job.with_receipt(result, receipt)
    return receipt_result(receipt, auto)


def _unrecorded(call: Call, hp: HashedPlan, result: Any, why: str) -> Result:
    """The action happened, but its receipt couldn't be kept: say so, and that undo isn't available."""
    note = (f"✓ {printable(hp.plan.summary)} happened, but its receipt couldn't be saved ({printable(why)}), "
            "so it can't be undone.")
    if call.job.guarded and result is not None:
        return call.job.with_note(result, note)
    safe, _ = json_safe(result)
    return t.CallToolResult(content=[t.TextContent(type="text", text=note)],
                            structured_content={"receipt": None, "result": safe})
