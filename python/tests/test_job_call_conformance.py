"""The job call vectors (../conformance/job-calls.json), generated from the TS reference: each call
runs through ``yea.job_call`` a round per step, and each step's store before, outcome, whether the
handler ran, and store after must match. The twin of ts/scripts/job-call-run.mjs.

The store is a MemoryStore behind a plain class (so the session issues consent codes) that records
each id it consumes. A step's ``race`` is reserved by "another call" just before the session's
first reservation, after the policy has decided."""

from __future__ import annotations

import asyncio

import pytest
from conftest import CONFORMANCE, load_vectors

from yea import Plan, clarify
from yea.approval import Tightening, load_policy
from yea.job_call import JobCall, JobTool, Outcome, Retry, job_call
from yea.store import LedgerKey, MemoryStore

DATA = load_vectors("job-calls")
pytestmark = pytest.mark.skipif(DATA is None, reason=f"{CONFORMANCE / 'job-calls.json'} missing")
NO_MAX = 10**40


def _calls():
    if DATA is None:
        return [pytest.param(None)]
    return [pytest.param(c, id=c["name"]) for c in DATA["calls"]]


def _key(id: str) -> LedgerKey:
    block, of = id.split(" ")
    return LedgerKey(block, of)


class VectorStore:
    """A MemoryStore that records what it consumed, and lets a race in before the first reserve."""

    def __init__(self) -> None:
        self.inner = MemoryStore()
        self.consumed: list[str] = []
        self.race: list[dict] = []

    async def consume_once(self, id: str, expires_at: int) -> bool:
        fresh = await self.inner.consume_once(id, expires_at)
        if fresh:
            self.consumed.append(id)
        return fresh

    async def reserve(self, k, amount, max):
        while self.race:
            r = self.race.pop(0)
            await self.inner.reserve(_key(r["key"]), int(r["amount"]), NO_MAX)
        return await self.inner.reserve(k, amount, max)

    def __getattr__(self, name):
        return getattr(self.inner, name)


async def _store_for(call: dict) -> VectorStore:
    s = VectorStore()
    setup = call["steps"][0]["before"]
    for id, amount in setup["used"].items():
        await s.inner.settle(await s.inner.reserve(_key(id), int(amount), NO_MAX))
    for id in setup["consumed"]:
        await s.consume_once(id, 2**53 - 1)
    for h, grant in (call.get("consents") or {}).items():
        await s.inner.put_consent(h, grant)
    return s


def _project(o: Outcome) -> dict:
    """An outcome as the vectors record it: plans by hash, a state without its random nonce."""
    hashes = [hp.plan_hash for hp in o.plans]
    if o.kind == "clarify":
        c = o.clarification
        return {"kind": o.kind, "clarify": {"question": c.question, "options": c.options}}
    if o.kind == "preview":
        return {"kind": o.kind, "plans": hashes}
    if o.kind == "run":
        held = [{"key": {"block": r.key.block, "of": r.key.of}, "amount": str(r.amount)} for r in o.held]
        return {"kind": o.kind, "plan": o.plan.plan_hash, "how": o.how, "held": held}
    if o.kind == "ask":
        f = o.form
        form = {"message": f["message"], "requestedSchema": f["requested_schema"], "offered": f["offered"]}
        return {"kind": o.kind, "form": form, "state": {k: v for k, v in o.state.items() if k != "nonce"}}
    if o.kind == "consent-codes":
        return {"kind": o.kind, "why": o.why, "plans": hashes, "codes": [c["planHash"] for c in o.codes],
                "unavailable": o.unavailable}
    return {"kind": o.kind, "why": o.why, **({"again": True} if o.again else {})}


def _tool(t: dict) -> JobTool:
    phrases = t.get("phrases")
    return JobTool(t["name"], t.get("risk"), (lambda r: None) if t.get("revert") else None,
                   (lambda hp, input: phrases.get(hp.plan_hash, "")) if phrases is not None else None)


def _handler(step: dict, ran: dict):
    async def plan():
        ran["planned"] = True
        p = step["plans"]
        if isinstance(p, dict):
            return clarify(p["clarify"]["question"], p["clarify"]["options"])
        return [Plan(d["summary"], d["effects"], lambda c: None, uses=d.get("uses"), risk=d.get("risk"),
                     undo_window=d.get("undoWindow")) for d in p]
    return plan


def _policy(p: dict):
    return load_policy(p["grant"], p["server"], p["principal"] or None, Tightening(tuple(p["deny"]), p["outOfBand"]))


async def _run(call: dict) -> list[dict]:
    s = await _store_for(call)
    states: dict[int, dict] = {}
    nonces: dict[str, int] = {}
    ledger = list(call["steps"][0]["before"]["used"])

    async def snapshot() -> dict:
        used = {id: str(await s.inner.used(_key(id))) for id in ledger}
        return {"used": used, "consumed": [f"nonce of step {nonces[i]}" if i in nonces else i for i in s.consumed]}

    out = []
    for i, step in enumerate(call["steps"], 1):
        before = await snapshot()
        ran = {"planned": False}
        retry = None
        if "retry" in step:
            st = step["retry"]["state"]
            st = states[st["fromStep"]] if isinstance(st, dict) and "fromStep" in st else st
            retry = Retry(st, step["retry"]["answer"])
        s.race[:] = step.get("race", [])
        facts = JobCall(_tool(call["tool"]), step["input"], _handler(step, ran), step["sub"], step["now"],
                        _policy(step["policy"]), step["canAsk"], step.get("preview", False), step.get("unpinned"))
        o = await job_call(facts, s, retry)
        if o.kind == "ask":
            states[i] = o.state
            nonces[o.state["nonce"]] = i
        out.append({"before": before, "outcome": _project(o), "planned": ran["planned"], "after": await snapshot()})
    return out


def test_the_keys_are_the_ones_every_step_uses():
    keys = DATA["keys"]
    for c in DATA["calls"]:
        for s in c["steps"]:
            assert s["policy"]["server"] == keys["server"]
            assert s["policy"]["principal"] in (keys["principal"], "")


@pytest.mark.parametrize("call", _calls())
def test_job_call(call):
    want = [{k: s[k] for k in ("before", "outcome", "planned", "after")} for s in call["steps"]]
    assert asyncio.run(_run(call)) == want
