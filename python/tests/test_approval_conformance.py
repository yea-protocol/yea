"""Shared approval vectors (../conformance/approval.json), generated from the TS reference (#48)."""

import asyncio
import json

import pytest
from conftest import CONFORMANCE

from yea import Plan
from yea.approval import (
    HashedPlan, Policy, Tightening, build_form, check_job_consent, checked_phrase, undo_receipt, check_state, decide, job_consent_code, judge_answer,
    load_policy,
    phrase_matches, plan_hash, read_tightening,
)
from yea.store import FileStore, LedgerKey, MemoryStore
from yea.uses import value

PATH = CONFORMANCE / "approval.json"
DATA = json.loads(PATH.read_text(encoding="utf-8")) if PATH.exists() else None
pytestmark = pytest.mark.skipif(DATA is None, reason=f"{PATH} missing")


def cases(section):
    items = (DATA or {}).get(section, [])
    return [pytest.param(c, id=c.get("name", str(i))) for i, c in enumerate(items)] or [pytest.param(None)]


def cases_of(section):
    items = ((DATA or {}).get(section) or {}).get("cases", [])
    return [pytest.param(c, id=c["name"]) for c in items] or [pytest.param(None)]


def to_plan(d):
    return Plan(d["summary"], d["effects"], lambda c: None, uses=d.get("uses"), risk=d.get("risk"),
                undo_window=d.get("undoWindow"))


def to_hashed(d):
    return HashedPlan(d["tool"], to_plan(d["plan"]), d["planHash"], d["risk"], d["undoable"])


def to_policy(d):
    tight = Tightening(tuple(d.get("deny", ())), d.get("outOfBand", "high"))
    if "grant" not in d:
        return Policy(deny=tight.deny, out_of_band=tight.out_of_band)
    return load_policy(d["grant"], d["server"], d["principal"], tight)


@pytest.mark.parametrize("case", cases("hash"))
def test_plan_hash(case):
    if case.get("error"):
        with pytest.raises(ValueError):
            plan_hash(case["tool"]["name"], case["input"], to_plan(case["plan"]), "low")
        return
    assert plan_hash(case["tool"]["name"], case["input"], to_plan(case["plan"]), case["risk"]) == case["planHash"]


@pytest.mark.parametrize("case", cases("decide"))
def test_decide(case):
    used = {of: value(q) for of, q in case["used"].items()}

    def used_of(k: LedgerKey) -> int:
        return used.get(k.of, 0)

    d = decide([to_hashed(p) for p in case["plans"]], to_policy(case["policy"]), used_of, case["now"])
    want = case["expect"]
    assert d.kind == want["kind"]
    assert d.why == want.get("why")
    if d.kind == "run":
        assert d.plan.plan_hash == want["planHash"]
        got = [{"key": {"block": k.block, "of": k.of}, "amount": str(a), "max": str(m)} for k, a, m in d.reserve]
        assert got == want["reserve"]


@pytest.mark.parametrize("case", cases("phrases"))
def test_phrases(case):
    assert phrase_matches(case["typed"], case["phrase"]) is case["match"]


@pytest.mark.parametrize("case", cases("forms"))
def test_forms(case):
    phrases = case["phrases"]
    form = build_form([to_hashed(p) for p in case["plans"]], case["why"], to_policy(case["policy"]),
                      lambda p: phrases[p.plan_hash])
    want = case["expect"]
    if want is None:
        assert form is None
        return
    assert form["message"] == want["message"]
    assert form["requested_schema"] == want["requestedSchema"]
    assert form["offered"] == want["offered"]


@pytest.mark.parametrize("case", cases("states"))
def test_states(case):
    e = case["expect"]
    assert (check_state(case["state"], e["tool"], e["inputHash"], e["sub"], e["now"]) is not None) is case["valid"]


@pytest.mark.parametrize("case", cases("judge"))
def test_judge(case):
    phrases = case["phrases"]
    v = judge_answer(case["state"], case["answer"], [to_hashed(p) for p in case["recomputed"]], to_policy(case["policy"]),
                     lambda p: phrases[p.plan_hash])
    want = case["expect"]
    assert v.kind == want["kind"]
    if "why" in want:
        assert v.why == want["why"]
    if "round" in want:
        assert v.round == want["round"]
    if "plan" in want:
        assert v.plan.plan_hash == want["plan"]


@pytest.mark.parametrize("case", cases("tightening"))
def test_tightening(case):
    t = read_tightening(case["file"])
    want = case["expect"]
    assert (list(t.deny), t.out_of_band, list(t.warnings)) == (want["deny"], want["outOfBand"], want["warnings"])


def test_consent_code():
    c = DATA["consentCode"]
    assert job_consent_code(c["server"], c["principal"], c["input"], to_hashed(c["plan"]), c["phrase"], c["now"]) == c["code"]


def test_file_store(tmp_path):
    """Replay the four operations; every file but receipts is byte-pinned."""
    refund = next(p for p in DATA["hash"] if p["name"] == "refund")["planHash"]

    async def go():
        s = FileStore(tmp_path)
        await s.consume_once("n_1", DATA["now"] + 600)
        r = await s.reserve(LedgerKey(DATA["policyBlockId"], "emails"), 5, 10)
        await s.settle(r)
        await s.put_consent(refund, "pg1.example")
        await s.claim_undo("r_AAAAAAAAAAAA")
        await s.mark_undone("r_AAAAAAAAAAAA")

    asyncio.run(go())
    files = {p.relative_to(tmp_path).as_posix(): "*" if p.suffix == ".claim" else p.read_text(encoding="utf-8")
             for p in tmp_path.rglob("*") if p.is_file()}
    assert files == DATA["fileStore"]["files"]


@pytest.mark.parametrize("case", cases_of("consents"))
def test_job_consents(case):
    c = DATA["consents"]
    policy = load_policy(None, DATA["keys"]["server"], DATA["keys"]["principal"], Tightening())
    got = check_job_consent(case["grant"], to_hashed(c["plan"]), policy, case["now"])
    want = case["expect"]
    assert got.ok is want["ok"]
    assert (got.id if got.ok else got.why) == (want["id"] if want["ok"] else want["why"])


@pytest.mark.parametrize("case", cases_of("undo"))
def test_undo(case):
    u = DATA["undo"]

    async def go():
        store = MemoryStore()
        for r in u["receipts"]:
            await store.put_receipt(r)
        if case["undoneBefore"]:
            first = await undo_receipt(store, case["id"], u["service"], case["sub"], case["now"], lambda _: None)
            assert first.kind == "undone"
        return await undo_receipt(store, case["id"], u["service"], case["sub"], case["now"], lambda _: None)

    got = asyncio.run(go())
    want = case["expect"]
    assert got.kind == want["kind"]
    if "why" in want:
        assert got.why == want["why"]


@pytest.mark.parametrize("c", cases("phraseChecks"))
def test_phrase_checks(c):
    if c is None:
        pytest.skip("no phraseChecks section")
    if c["expect"] is None:
        with pytest.raises(TypeError):
            checked_phrase(c["phrase"])
    else:
        assert checked_phrase(c["phrase"]) == c["expect"]
