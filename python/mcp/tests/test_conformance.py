"""The approval vectors the SDK core can't check alone: a plan's hash, risk and undoability as
yea-mcp's hash_plans works them out from the tool (conformance/approval.json ``hash``, as
ts/test/conformance.test.ts runs hashPlans)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from yea import Plan

from yea_mcp.call import JobDef, hash_plans

VECTORS = Path(__file__).resolve().parents[3] / "conformance" / "approval.json"
HASH = [c for c in json.loads(VECTORS.read_text(encoding="utf-8"))["hash"] if not c.get("error")]


def plan_of(d: dict) -> Plan:
    return Plan(d["summary"], d["effects"], apply=lambda c: None, uses=d.get("uses"), risk=d.get("risk"),
                undo_window=d.get("undoWindow"))


@pytest.mark.parametrize("case", HASH, ids=[c["name"] for c in HASH])
def test_hash_plans_matches_the_vectors(case):
    tool = case["tool"]
    # By presence, as TS's `tool.revert !== undefined`.
    job = JobDef(tool["name"], tool.get("risk"), (lambda r, ctx: None) if "revert" in tool else None, None)
    [hp] = hash_plans(job, case["input"], [plan_of(case["plan"])])
    assert [hp.plan_hash, hp.risk, hp.undoable] == [case["planHash"], case["risk"], case["undoable"]]
