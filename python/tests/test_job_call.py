"""The job call session (yea.job_call): what the vectors in conformance/job-calls.json can't show,
the fallback an ask carries and the errors that refuse a call before anything runs. As
ts/test/job-call.test.ts."""

from __future__ import annotations

import asyncio

import pytest

from yea import Plan, key_from_seed
from yea.approval import Policy
from yea.job_call import JobCall, JobTool, job_call
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
