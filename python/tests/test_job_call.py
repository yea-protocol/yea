"""The job call session (yea.job_call): what the vectors in conformance/job-calls.json can't show,
the fallback an ask carries and the errors that refuse a call before anything runs. As
ts/test/job-call.test.ts."""

from __future__ import annotations

import asyncio

import pytest

from yea import Plan, issue_grant, key_from_seed, quantity
from yea.approval import Policy, Tightening, load_policy, release_all, settle_all
from yea.grants import LedgerKey, Period
from yea.job_call import JobCall, JobTool, job_call
from yea.lens import fmt_time
from yea.store import MemoryStore

NOW = 1_790_000_000
PRINCIPAL = key_from_seed(bytes([1]) * 32).public
SERVER = key_from_seed(bytes([5]) * 32).public


class FileLike:
    """A MemoryStore the session doesn't treat as one, so it issues consent codes."""

    def __init__(self) -> None:
        self.inner = MemoryStore()

    def __getattr__(self, name):
        return getattr(self.inner, name)


def call(plan=None, input=None, tool=None, can_ask=True) -> JobCall:
    async def refund():
        return [Plan("Refund", [], apply=lambda c: None, risk="low")]
    return JobCall(tool or JobTool("refund"), input or {"who": "Chen"}, plan or refund, "", NOW,
                   Policy(principal=PRINCIPAL, server_key=SERVER), can_ask)


def test_an_ask_carries_what_to_return_instead_when_the_client_is_unreachable():
    o = asyncio.run(job_call(call(), FileLike()))
    assert o.kind == "ask" and o.otherwise is not None
    instead = o.otherwise()
    assert instead.kind == "consent-codes" and instead.why == "refund can't be undone"
    assert [c["planHash"] for c in instead.codes] == o.form["offered"] and instead.unavailable is None


def test_a_memory_store_gets_no_consent_codes():
    o = asyncio.run(job_call(call(can_ask=False), MemoryStore()))
    assert o.kind == "consent-codes" and "keeps approvals in memory" in (o.unavailable or "")


def test_a_non_integer_input_raises_before_the_handler_runs():
    planned = []

    async def plan():
        planned.append(1)
        return []

    with pytest.raises(ValueError, match="only integer numbers"):
        asyncio.run(job_call(call(plan=plan, input={"amount": 1.5}), MemoryStore()))
    assert planned == []


def test_a_handler_that_returns_neither_plans_nor_a_clarification_raises():
    async def plan():
        return "refund"

    with pytest.raises(TypeError, match="must return a list of plans or clarify"):
        asyncio.run(job_call(call(plan=plan), MemoryStore()))


def test_a_phrase_no_one_could_type_raises_before_anyone_is_asked():
    tool = JobTool("refund", confirm_with=lambda hp, input: "go‮")
    with pytest.raises(TypeError, match="the phrase from confirm_with\\(\\) has unprintable characters"):
        asyncio.run(job_call(call(tool=tool), MemoryStore()))


# #405: a signed policy whose ``total`` counts per week (SPEC.md §6.3, SPEC-approval §5). The plan is
# the flagship's shape (#406): medium risk, an ``each``, a weekly ``total``, a 60-second undo. As
# "a policy with a weekly total" in ts/test/job-call.test.ts.

WEEK = 7 * 86400
WEEK0 = NOW - 3 * 86400  # the policy's nbf: NOW is in its first week


def _weekly_policy() -> Policy:
    grant = issue_grant(key_from_seed(bytes([1]) * 32), SERVER, [
        {"can": ["buy"]},
        {"risk": "medium"},
        {"each": {"of": "spend", "max": 30000, "scale": 2, "unit": "USD"}},
        {"total": {"of": "spend", "max": 50000, "scale": 2, "unit": "USD", "every": WEEK}},
        {"nbf": WEEK0},
        {"exp": WEEK0 + 8 * WEEK},
    ], iat=WEEK0)
    return load_policy(grant, SERVER, PRINCIPAL, Tightening())


def _buy(cents: int, at: int, policy: Policy) -> JobCall:
    async def plan():
        return [Plan(f"Buy {cents / 100} USD", [], apply=lambda c: None, risk="medium",
                     uses={"spend": quantity(cents, scale=2, unit="USD")}, undo_window=60)]
    return JobCall(JobTool("buy", revert=lambda c: None), {"cents": cents}, plan, "", at, policy, True)


async def _run(store, cents: int, at: int, policy: Policy):
    """One call: a run settles what it holds, as the adapter does once the plan applies."""
    o = await job_call(_buy(cents, at, policy), store)
    if o.kind == "run":
        await settle_all(store, o.held)
    return o


def _week_of(policy: Policy, start: int) -> LedgerKey:
    return LedgerKey(policy.grant.id, "spend", Period(WEEK, start))


def test_a_weekly_total_asks_in_the_week_it_filled_runs_in_the_next_until_that_fills_and_keeps_the_old_week():
    async def go():
        store, policy, next_week = FileLike(), _weekly_policy(), WEEK0 + WEEK
        assert (await _run(store, 30000, NOW, policy)).kind == "run"
        asked = await _run(store, 30000, NOW, policy)
        assert asked.kind == "ask" and asked.otherwise is not None
        assert asked.otherwise().why == (
            f"spend would pass the total limit of 500.00 USD every 7d (starts again {fmt_time(next_week)})")
        assert (await _run(store, 30000, next_week + 60, policy)).kind == "run"
        assert (await _run(store, 20000, next_week + 120, policy)).kind == "run"
        assert (await _run(store, 1, next_week + 180, policy)).kind == "ask"
        assert await store.used(_week_of(policy, WEEK0)) == 300 * 10**18
        assert await store.used(_week_of(policy, next_week)) == 500 * 10**18

    asyncio.run(go())


def test_a_clock_in_fractional_seconds_is_floored_the_run_counts_in_the_period_of_its_whole_second():
    async def go():
        store, policy = FileLike(), _weekly_policy()
        # Half a second before the second week: floored, it is in the first; rounded, in the second.
        o = await job_call(_buy(30000, WEEK0 + WEEK - 0.5, policy), store)
        assert o.kind == "run"
        assert [h.key for h in o.held] == [_week_of(policy, WEEK0)]

    asyncio.run(go())


def test_a_weekly_reservation_released_after_the_week_ends_frees_that_week_only():
    async def go():
        store, policy = FileLike(), _weekly_policy()
        o = await job_call(_buy(30000, WEEK0 + WEEK - 1, policy), store)
        assert o.kind == "run"
        # The plan failed after the boundary: what it held goes back to the week it was taken in.
        await release_all(store, o.held)
        assert await store.used(_week_of(policy, WEEK0)) == 0
        assert await store.used(_week_of(policy, WEEK0 + WEEK)) == 0
        assert (await _run(store, 30000, WEEK0 + WEEK - 1, policy)).kind == "run"

    asyncio.run(go())
