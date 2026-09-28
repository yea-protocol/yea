"""Approval for job tools (docs/framework/SPEC-approval.md): unit and security tests."""

import asyncio
import os
from pathlib import Path

import pytest

from yea import Plan, create, decode_consent_code, issue_grant, key_from_seed, quantity, spend
from yea.approval import (
    HashedPlan, Policy, Tightening, build_form, check_key_file, check_state, choose_store, decide, input_hash,
    job_consent_code, judge_answer, load_policy, new_receipt_id, new_state, normalize_phrase, phrase_matches, plan_hash,
    plan_preimage, read_tightening, reserve_all, undo_receipt,
)
from yea.store import FileStore, LedgerKey, MemoryStore, StoreError, is_receipt_id
from yea._json import canonical, sha256_b64url

PRINCIPAL = key_from_seed(bytes([7]) * 32)
SERVER = key_from_seed(bytes([8]) * 32)
OTHER = key_from_seed(bytes([9]) * 32)
NOW = 1_790_000_000


def plan(summary="Delete old-nav", undo=3600, uses=None, risk=None):
    return Plan(summary, [create("branch/old-nav")], lambda c: None, uses=uses, risk=risk, undo_window=undo)


def hashed(tool="delete_branch", input=None, p=None, risk="low", undoable=True):
    p = p or plan()
    input = input if input is not None else {"repo": "site", "branch": "old-nav"}
    return HashedPlan(tool, p, plan_hash(tool, input, p, risk), risk, undoable)


def policy(*caveats, deny=(), oob="high", principal=PRINCIPAL, issued_to=SERVER):
    g = issue_grant(principal, issued_to.public, list(caveats), iat=NOW)
    return load_policy(g, SERVER.public, PRINCIPAL.public, Tightening(tuple(deny), oob), NOW)


def no_use(k):
    return 0


# ------------------------------------------------------------------ §1 plan hash


def test_plan_hash_is_stable_and_binds_input_and_content():
    a = hashed()
    assert a.plan_hash == hashed().plan_hash  # recomputing the same plan gives the same hash
    assert a.plan_hash != hashed(input={"repo": "site", "branch": "main"}).plan_hash
    assert a.plan_hash != hashed(tool="archive_branch").plan_hash
    assert a.plan_hash != hashed(risk="medium").plan_hash
    assert a.plan_hash != hashed(p=plan(undo=60)).plan_hash
    assert a.plan_hash != hashed(p=plan(uses={"deletions": quantity(1)})).plan_hash


def test_plan_preimage_leaves_out_absent_fields():
    pre = plan_preimage("t", {"a": 1}, plan(undo=None), "medium")
    assert set(pre) == {"tool", "input", "summary", "effects", "risk"}
    assert sha256_b64url(canonical(pre).encode()) == plan_hash("t", {"a": 1}, plan(undo=None), "medium")
    # An empty uses is absent, as on the wire.
    assert "uses" not in plan_preimage("t", {}, plan(uses={}), "low")


def test_non_integer_input_fails_closed():
    with pytest.raises(ValueError, match="use a string or an integer"):
        plan_hash("refund", {"amount": 22.87}, plan(), "low")


# ------------------------------------------------------------------ §3 phrases


@pytest.mark.parametrize("typed,phrase,ok", [
    ("approve", "approve", True),
    ("  Approve\n", "approve", True),
    ("﻿APPROVE ", "approve", True),
    (" approve", "approve", False),  # an em space is not in the strip set
    ("old-nav", "Old-Nav", True),
    ("café", "café", True),  # NFC
    ("strasse", "straße", False),  # lower(), not casefold()
    ("", "approve", False),
    (None, "approve", False),
])
def test_phrase_matching(typed, phrase, ok):
    assert phrase_matches(typed, phrase) is ok


def test_normalize_phrase_strips_exactly_the_set():
    assert normalize_phrase("\t\n\x0b\x0c\r  ﻿X﻿") == "x"
    assert normalize_phrase("​x") == "​x"


# ------------------------------------------------------------------ §2 policy


def test_read_tightening_ignores_unknown_and_loosening():
    t = read_tightening({"deny": ["delete_customer"], "outOfBand": "medium", "allow": ["*"]})
    assert t.deny == ("delete_customer",) and t.out_of_band == "medium" and len(t.warnings) == 1
    t = read_tightening({"outOfBand": "never", "deny": "delete_customer"})
    assert t.deny == () and t.out_of_band == "high" and len(t.warnings) == 2
    assert read_tightening(None) == Tightening()
    assert read_tightening([1]).warnings


def test_deleting_the_policy_file_returns_to_the_defaults():
    t = read_tightening(None)
    assert t.deny == () and t.out_of_band == "high"
    p = load_policy(None, SERVER.public, PRINCIPAL.public, t, NOW)
    assert decide([hashed()], p, no_use).kind == "ask"
    assert decide([hashed(risk="high")], p, no_use).kind == "out-of-band"


def test_key_file_owned_or_writable_by_this_user_is_refused(tmp_path):
    f = tmp_path / "principal.pub"
    f.write_text(PRINCIPAL.public)
    why = check_key_file(f)
    assert why is not None and "owned by this server's user" in why
    assert check_key_file(tmp_path / "missing.pub") is not None


@pytest.mark.skipif(os.geteuid() == 0, reason="root owns everything")
def test_key_file_out_of_reach_is_accepted():
    hosts = Path("/etc/hosts").resolve()
    if any(q.stat().st_uid == os.geteuid() or os.access(q, os.W_OK) for q in (hosts, *hosts.parents)):
        pytest.skip("no root-owned read-only file to test with")
    assert check_key_file(hosts) is None


def test_unsigned_or_foreign_policy_never_auto_runs():
    assert decide([hashed()], policy({"can": ["*"]}, principal=OTHER), no_use).kind == "ask"  # not the pinned principal
    assert decide([hashed()], policy({"can": ["*"]}, issued_to=OTHER), no_use).kind == "ask"  # issued to another server
    assert decide([hashed()], policy({"can": ["*"]}, {"svc": ["elsewhere"]}), no_use).kind == "ask"
    assert decide([hashed()], policy({"can": ["*"]}, {"exp": NOW}), no_use).kind == "ask"
    p = load_policy("pg1.not-a-grant", SERVER.public, PRINCIPAL.public, Tightening(), NOW)
    assert p.grant is None and decide([hashed()], p, no_use).kind == "ask"


# ------------------------------------------------------------------ decide


def test_within_policy_runs():
    d = decide([hashed()], policy({"can": ["delete_branch"]}, {"risk": "low"}), no_use)
    assert d.kind == "run" and d.plan is not None and d.reserve == ()


def test_deny_refuses_first():
    d = decide([hashed(risk="high")], policy({"can": ["*"]}, deny=["delete_branch"]), no_use)
    assert d.kind == "denied"


def test_irreversible_never_auto_runs():
    d = decide([hashed(undoable=False)], policy({"can": ["*"]}, {"risk": "high"}), no_use)
    assert d.kind == "ask" and d.why == "`delete_branch` can't be undone"


def test_high_risk_goes_out_of_band_even_with_a_grant():
    assert decide([hashed(risk="high")], policy({"can": ["*"]}, {"risk": "high"}), no_use).kind == "out-of-band"
    assert decide([hashed(risk="medium")], policy({"can": ["*"]}, oob="medium"), no_use).kind == "out-of-band"


def test_reasons():
    assert decide([hashed(risk="medium")], policy({"can": ["*"]}, {"risk": "low"}), no_use).why == "risk is medium, and your limit is low"
    assert "doesn't let `delete_branch`" in decide([hashed()], policy({"can": ["reschedule"]}), no_use).why
    over = hashed(p=plan(uses={"spend": spend("25.01", "USD")}))
    d = decide([over], policy({"can": ["*"]}, {"each": {"of": "spend", "max": 2500, "scale": 2, "unit": "USD"}}), no_use)
    assert d.kind == "ask" and "spend over the per-commit limit of 25.00 USD" in d.why


def test_a_plan_without_uses_passes_limits():
    p = policy({"can": ["*"]}, {"each": {"of": "spend", "max": 0}}, {"total": {"of": "emails", "max": 0}})
    assert decide([hashed()], p, no_use).kind == "run"


def test_totals_reserve_once_per_block_and_measure_with_the_smallest_max():
    p = policy({"can": ["*"]}, {"total": {"of": "emails", "max": 20}}, {"total": {"of": "emails", "max": 5}})
    h = hashed(p=plan(uses={"emails": quantity(2)}))
    d = decide([h], p, no_use)
    assert d.kind == "run" and len(d.reserve) == 1
    key, amount, mx = d.reserve[0]
    assert key.of == "emails" and amount == 2 * 10**18 and mx == 5 * 10**18
    assert decide([h], p, lambda k: 4 * 10**18).kind == "ask"  # 4 used + 2 > 5


def test_only_plans0_can_run():
    second = hashed(p=plan("Archive old-nav"))
    d = decide([hashed(undoable=False), second], policy({"can": ["*"]}), no_use)
    assert d.kind == "ask"


# ------------------------------------------------------------------ the form and the state


def test_form_leaves_out_of_band_plans_out_of_the_choice():
    low, high = hashed(), hashed(p=plan("Force-delete old-nav"), risk="high")
    form = build_form([low, high], "`delete_branch` can't be undone", {low.plan_hash: "old-nav", high.plan_hash: "old-nav"})
    props = form["requestedSchema"]["properties"]
    assert "plan" not in props  # only one plan can be chosen here
    assert "old-nav" in props["confirm"]["description"]
    assert "outside the chat" in form["message"]
    two = [low, hashed(p=plan("Archive old-nav"))]
    props = build_form(two, "why", {two[0].plan_hash: "a", two[1].plan_hash: "b"})["requestedSchema"]["properties"]
    assert [o["const"] for o in props["plan"]["oneOf"]] == [p.plan_hash for p in two]
    assert set(form["requestedSchema"]["required"]) == set(form["requestedSchema"]["properties"])


def test_state_holds_only_hashes_a_counter_and_a_nonce():
    s = new_state("delete_branch", input_hash({"b": "x"}), "", [hashed().plan_hash], 1, NOW)
    assert set(s) == {"v", "tool", "inputHash", "sub", "plans", "round", "nonce", "exp"}
    assert check_state(s, "delete_branch", input_hash({"b": "x"}), "", NOW) is None
    bad = [
        check_state(s, "other_tool", s["inputHash"], "", NOW),
        check_state(s, "delete_branch", input_hash({"b": "y"}), "", NOW),
        check_state(s, "delete_branch", s["inputHash"], "someone", NOW),
        check_state(s, "delete_branch", s["inputHash"], "", s["exp"]),
        check_state({**s, "round": 4}, "delete_branch", s["inputHash"], "", NOW),
        check_state("garbage", "delete_branch", s["inputHash"], "", NOW),
    ]
    assert len(set(bad)) == 1 and bad[0] is not None


# ------------------------------------------------------------------ judging answers


def _judge(answer, plans=None, state_plans=None, round=1, pol=None):
    plans = plans or [hashed()]
    state = new_state("delete_branch", "ih", "", state_plans or [p.plan_hash for p in plans], round, NOW)
    return judge_answer(state, answer, plans, pol or policy(), lambda p: "old-nav")


def test_decline_and_cancel_are_not_approved():
    assert _judge({"action": "decline"}).kind == "not-approved"
    assert _judge({"action": "cancel"}).kind == "not-approved"


def test_bare_accept_never_counts():
    v = _judge({"action": "accept"})
    assert v.kind == "ask-again" and v.round == 2
    assert _judge({"action": "accept", "content": {}}).kind == "ask-again"


def test_right_phrase_runs_and_three_wrong_refuse():
    assert _judge({"action": "accept", "content": {"confirm": " OLD-NAV "}}).kind == "run"
    assert _judge({"action": "accept", "content": {"confirm": "approve"}}, round=2).kind == "ask-again"
    assert _judge({"action": "accept", "content": {"confirm": "approve"}}, round=3).kind == "refuse"


def test_changed_plans_ask_again():
    old = hashed(p=plan("Delete old-nav at abc123"))
    v = _judge({"action": "accept", "content": {"plan": old.plan_hash, "confirm": "old-nav"}}, plans=[hashed()],
               state_plans=[old.plan_hash, "x"])
    assert v.kind == "ask-again" and "changed" in v.why


def test_a_plan_not_offered_cant_be_chosen():
    a, b = hashed(), hashed(p=plan("Archive old-nav"))
    v = _judge({"action": "accept", "content": {"plan": b.plan_hash, "confirm": "old-nav"}}, plans=[a, b], state_plans=[a.plan_hash])
    assert v.kind == "ask-again"


def test_high_plan_cant_be_approved_in_the_form_even_as_plans1():
    low, high = hashed(), hashed(p=plan("Force-delete"), risk="high")
    v = _judge({"action": "accept", "content": {"plan": high.plan_hash, "confirm": "old-nav"}}, plans=[low, high])
    assert v.kind == "out-of-band" and v.plan == high


def test_denied_tool_never_runs_even_with_approval():
    v = _judge({"action": "accept", "content": {"confirm": "old-nav"}}, pol=policy(deny=["delete_branch"]))
    assert v.kind == "denied"


# ------------------------------------------------------------------ §6 consent codes


def test_job_consent_code_carries_the_preimage():
    h = hashed()
    code = job_consent_code(SERVER.public, PRINCIPAL.public, h.tool, {"repo": "site", "branch": "old-nav"}, h.plan, h.plan_hash, h.risk, NOW)
    c = decode_consent_code(code)
    assert c["hash"] == c["proposal"] == h.plan_hash and c["service"] == SERVER.public and c["capability"] == "delete_branch"
    assert c["expires"] == NOW + 600
    assert sha256_b64url(canonical(c["detail"]).encode()) == h.plan_hash  # an approver can re-check it


# ------------------------------------------------------------------ the store


@pytest.fixture(params=["memory", "file"])
def store(request, tmp_path):
    return MemoryStore() if request.param == "memory" else FileStore(tmp_path / "store")


def run(coro):
    return asyncio.run(coro)


def test_consume_once_under_concurrency(store):
    async def go():
        results = await asyncio.gather(*(store.consume_once("nonce-1", NOW + 600) for _ in range(20)))
        assert results.count(True) == 1
        assert await store.consume_once("nonce-2", NOW + 600)

    run(go())


def test_claim_undo_once_and_release(store):
    async def go():
        rid = "r_abcdefghijkl"
        assert await store.claim_undo(rid) and not await store.claim_undo(rid)
        await store.release_undo(rid)
        assert await store.claim_undo(rid)
        await store.mark_undone(rid)
        await store.release_undo(rid)
        assert not await store.claim_undo(rid)  # done is done

    run(go())


def test_undo_ids_must_be_in_the_generated_format(store):
    async def go():
        assert not is_receipt_id("../x") and not is_receipt_id("r_short") and is_receipt_id("r_abcdefgh")
        with pytest.raises(StoreError):
            await store.claim_undo("../x")
        assert await store.get_receipt("../x") is None
        with pytest.raises(StoreError):
            await store.put_receipt({"id": "r_../../etc"})

    run(go())


def test_receipts_round_trip(store):
    async def go():
        r = {"id": "r_abcdefghijkl", "tool": "t", "input": {"a": 1}, "planHash": "h", "sub": "", "result": {"x": 1.5}}
        await store.put_receipt(r)
        assert await store.get_receipt(r["id"]) == r
        assert await store.get_receipt("r_nonexistent0") is None

    run(go())


def test_reservations_under_concurrency_and_failure(store):
    async def go():
        k = LedgerKey("B" * 43, "emails")
        one = 10**18
        rs = await asyncio.gather(*(store.reserve(k, one, 5 * one) for _ in range(8)))
        held = [r for r in rs if r is not None]
        assert len(held) == 5 and await store.used(k) == 5 * one
        await store.release(held[0])
        await store.settle(held[1])
        assert await store.used(k) == 4 * one
        assert await store.reserve(k, 2 * one, 5 * one) is None
        await store.settle(held[1])  # settling twice changes nothing
        assert await store.used(k) == 4 * one

    run(go())


def test_consents_by_plan_hash(store):
    async def go():
        assert await store.get_consent("planhash") is None
        await store.put_consent("planhash", "pg1.token")
        assert await store.get_consent("planhash") == "pg1.token"
        with pytest.raises(StoreError):
            await store.put_consent("../escape", "x")

    run(go())


def test_file_store_layout(tmp_path):
    async def go():
        s = FileStore(tmp_path)
        await s.consume_once("id-1", 1790000600)
        marker = next((tmp_path / "consumed").iterdir())
        assert marker.name == sha256_b64url(b"id-1") and marker.read_text() == "1790000600"
        await s.claim_undo("r_abcdefghijkl")
        await s.mark_undone("r_abcdefghijkl")
        assert (tmp_path / "undo" / "r_abcdefghijkl.done").exists()
        k = LedgerKey("B" * 43, "spend")
        r = await s.reserve(k, 2287 * 10**16, 10**20)
        path = tmp_path / "ledger" / k.block / "spend.json"
        assert path.read_text() == f'{{"settled":"0","reserved":{{"{r.id}":"22870000000000000000"}}}}'
        assert r.id.startswith("v_") and len(r.id) == 14
        await s.settle(r)
        assert path.read_text() == '{"settled":"22870000000000000000","reserved":{}}'
        assert not (tmp_path / "ledger" / k.block / "spend.lock").exists()
        await s.put_consent("hash1", "pg1.x")
        assert (tmp_path / "consents" / "hash1").read_text() == "pg1.x"

    run(go())


def test_file_store_breaks_a_stale_lock_and_fails_closed_on_a_live_one(tmp_path):
    async def go():
        s = FileStore(tmp_path)
        k = LedgerKey("B" * 43, "spend")
        lock = tmp_path / "ledger" / k.block / "spend.lock"
        lock.parent.mkdir(parents=True)
        lock.write_text("1")
        os.utime(lock, (0, 0))  # left by a crashed process long ago
        assert await s.reserve(k, 1, 10) is not None
        lock.write_text("1")  # held right now
        import yea.store as st

        old, st.LOCK_WAIT = st.LOCK_WAIT, 0.05
        try:
            with pytest.raises(StoreError):
                await s.reserve(k, 1, 10)
        finally:
            st.LOCK_WAIT = old

    run(go())


def test_corrupt_ledger_fails_closed(tmp_path):
    async def go():
        s = FileStore(tmp_path)
        k = LedgerKey("B" * 43, "spend")
        (tmp_path / "ledger" / k.block).mkdir(parents=True)
        (tmp_path / "ledger" / k.block / "spend.json").write_text("{nope")
        with pytest.raises(StoreError):
            await s.used(k)

    run(go())


def test_policy_without_a_grant_still_carries_tightenings():
    p = Policy(deny=("x",))
    assert p.grant is None and decide([hashed(tool="x")], p, no_use).kind == "denied"


def test_a_symlink_in_a_writable_directory_is_refused(tmp_path):
    hosts = Path("/etc/hosts")
    if not hosts.exists():
        pytest.skip("no /etc/hosts")
    link = tmp_path / "principal.pub"
    link.symlink_to(hosts)
    assert check_key_file(link) is not None


def test_a_partly_failed_reservation_releases_the_ones_already_made(store):
    async def go():
        a, b = LedgerKey("A" * 43, "emails"), LedgerKey("B" * 43, "emails")
        one = 10**18
        await store.reserve(b, 5 * one, 5 * one)  # b is full
        assert await reserve_all(store, ((a, one, 5 * one), (b, one, 5 * one))) is None
        assert await store.used(a) == 0
        held = await reserve_all(store, ((a, one, 5 * one),))
        assert held is not None and await store.used(a) == one

    run(go())


def _receipt(rid, until, sub=""):
    return {"id": rid, "tool": "delete_branch", "input": {"b": "x"}, "planHash": "h", "sub": sub,
            "summary": "s", "effects": [], "undo": None if until is None else {"until": until}, "result": {"sha": "abc"}}


def test_undo_once_within_the_window_for_the_same_principal(store):
    async def go():
        calls = []
        rid = new_receipt_id()
        assert is_receipt_id(rid) and len(rid) == 14
        await store.put_receipt(_receipt(rid, NOW + 60))
        assert (await undo_receipt(store, rid, "someone-else", NOW, calls.append)).kind == "not-found"
        assert (await undo_receipt(store, rid, "", NOW + 61, calls.append)).why == "the undo window has closed"
        assert (await undo_receipt(store, rid, "", NOW, calls.append)).kind == "undone"
        assert calls == [{"input": {"b": "x"}, "planHash": "h", "result": {"sha": "abc"}}]
        assert (await undo_receipt(store, rid, "", NOW, calls.append)).kind == "refused" and len(calls) == 1
        assert (await undo_receipt(store, "../x", "", NOW, calls.append)).kind == "not-found"
        never = new_receipt_id()
        await store.put_receipt(_receipt(never, None))
        assert "never" in (await undo_receipt(store, never, "", NOW, calls.append)).why

    run(go())


def test_a_failed_revert_can_be_tried_again(store):
    async def go():
        rid = new_receipt_id()
        await store.put_receipt(_receipt(rid, NOW + 60))

        def boom(_):
            raise RuntimeError("github is down")

        with pytest.raises(RuntimeError):
            await undo_receipt(store, rid, "", NOW, boom)
        assert (await undo_receipt(store, rid, "", NOW, lambda _: None)).kind == "undone"

    run(go())


def test_http_with_a_total_on_the_memory_store_refuses_to_start():
    p = policy({"can": ["*"]}, {"total": {"of": "emails", "max": 20}})
    with pytest.raises(ValueError, match="shared store"):
        choose_store(True, None, p)
    assert isinstance(choose_store(True, None, p, single_process=True), MemoryStore)
    assert isinstance(choose_store(True, None, policy({"can": ["*"]})), MemoryStore)
    assert isinstance(choose_store(False, None, p), FileStore)
