"""The commit ledger vectors (../conformance/commit-ledger.json), generated from the TS reference: the
order a COMMIT is checked in (SPEC §4.4, ADR-0002). Each case sets a scene and commits, and must get
the same outcome, with grant evaluation run or not as it ran in TS. The twin of
ts/scripts/commit-ledger-run.mjs.

The scene: alice's agent has a proposal to pay 10 cents, expiring 600s from now, under a grant with a
``total`` of 100 cents. ``committed`` commits it first; ``full`` first commits another proposal that
takes the whole 100; ``late`` moves the clock to its expiry. Then ``by`` commits it, with grant
evaluation that answers ``admit`` whatever the usage ledger holds."""

from __future__ import annotations

import asyncio

import pytest
from commit_ledger_fixture import LedgerFixture, commit_of
from conftest import CONFORMANCE, load_vectors

from yea import YeaError
from yea.service.commit_ledger import Admitted, TotalLimit

DATA = load_vectors("commit-ledger")
pytestmark = pytest.mark.skipif(DATA is None, reason=f"{CONFORMANCE / 'commit-ledger.json'} missing")
TOTAL = TotalLimit("b_1", "spend", 10**18)  # 100 cents, exact at scale 18


def _cases():
    if DATA is None:
        return [pytest.param(None)]
    return [pytest.param(c, id=c["name"]) for c in DATA]


def _no_events(_e):
    pass


async def run_case(c: dict) -> dict:
    f = LedgerFixture()

    def admits(proposal, used):
        return Admitted("alice", [TOTAL])

    p = f.propose(10)
    if c["committed"]:
        await f.ledger.commit(commit_of(p, admits), _no_events)
    if c["full"]:
        await f.ledger.commit(commit_of(f.propose(100), admits), _no_events)
    if c["late"]:
        f.t = p.proposal["expires"]
    evaluated = []

    def admit(proposal, used):
        evaluated.append(1)
        return Admitted(c["by"], [TOTAL]) if c["admit"] == "admits" else YeaError(c["admit"], "grant evaluation refused it")

    try:
        out = await f.ledger.commit(commit_of(p, admit, c["by"]), _no_events)
    except YeaError as e:
        return {"outcome": e.code, "evaluated": bool(evaluated)}
    outcome = ("replay" if out.get("replay") else "RECEIPT") if out["kind"] == "RECEIPT" else out["code"]
    return {"outcome": outcome, "evaluated": bool(evaluated)}


@pytest.mark.parametrize("case", _cases())
def test_commit_ledger_vector(case):
    assert asyncio.run(run_case(case)) == {"outcome": case["outcome"], "evaluated": case["evaluated"]}
