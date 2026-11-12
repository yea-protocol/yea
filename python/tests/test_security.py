"""The SDK's security regression list, ported from ts/test/security.test.ts (#153). Each test
names the TS id it mirrors."""

import asyncio
import base64
import json
import os
import socket
import time
import urllib.error
import urllib.request
from pathlib import Path
from types import SimpleNamespace

import pytest
from commit_ledger_fixture import LedgerFixture, TotalGrant, code_of, commit_of, grant_admit

from yea import (
    Client, GrantContext, Plan, Service, consent_grant, create, decode_grant, delegate_grant, issue_grant, key_from_seed,
    lens, local, serve_http, verify_grant,
)
from yea._json import MAX_SAFE_INT, b64url_encode, canonical, sha256_b64url
from yea.approval import Policy, Tightening, consent_hash_of, job_consent_code, load_policy, reserve_all
from yea.errors import YeaError
from yea.grants import Grant, Period
from yea.job_call import JobCall, JobTool, Outcome, Retry, hash_plans, job_call
from yea.keys import sign_proof
from yea.service.commit_ledger import Admitted, TotalLimit
from yea.service.verified_request import VerifiedIntent, verify_request
from yea.store import FileStore, LedgerKey, MemoryStore, StoreError
from yea.uses import quantity

PRINCIPAL = key_from_seed(bytes([1]) * 32)
AGENT = key_from_seed(bytes([2]) * 32)


def run(coro):
    return asyncio.run(coro)


def pay_service(runs=None, slow=0.0, now=None):
    """A payment service: ``pay.send`` spends ``amt`` hundredths of a dollar."""
    svc = Service("pay", "Pay", "pay", trust=[PRINCIPAL.public], now=now)

    async def apply(ctx):
        if runs is not None:
            runs.append(1)
        await asyncio.sleep(slow)

    @svc.intent("pay.send", "send money", {"to": "string", "amt": "int"})
    def send(ctx):
        return Plan(f"pay {ctx.params['to']}", [create(f"payment/{ctx.params['to']}")], apply=apply,
                    uses={"spend": quantity(ctx.params["amt"], scale=2, unit="USD")})

    return svc


def client(svc, *caveats):
    return Client(local(svc), key=AGENT, grants=[issue_grant(PRINCIPAL, AGENT.public, list(caveats)).encode()])


async def proposal(c, to, amt):
    r = await c.intent("pay.send", {"to": to, "amt": amt})
    assert r.kind == "PROPOSALS", r.lens
    return r.proposals[0]


def test_h1_malformed_or_aborted_http_requests_dont_crash_the_bridge():
    """[H1] Raw bad requests, then a hang-up; the bridge still answers, and a big POST gets 413."""
    async def go():
        http = await serve_http(pay_service(), "127.0.0.1", 0)
        port = http.sockets[0].getsockname()[1]
        try:
            def raw(data):
                with socket.create_connection(("127.0.0.1", port), timeout=5) as s:
                    s.sendall(data)
                    time.sleep(0.15)  # then hang up mid-request

            for data in (b"GET /yea HTTP/1.1\r\nHost: [bad\r\n\r\n",
                         b"POST /yea HTTP/1.1\r\nHost: x\r\nContent-Length: 1000\r\n\r\nhello"):
                await asyncio.to_thread(raw, data)

            def get(path, data=None):
                req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=data,
                                             method="POST" if data else "GET")
                try:
                    with urllib.request.urlopen(req, timeout=5) as r:
                        return r.status, r.read()
                except urllib.error.HTTPError as e:
                    return e.code, e.read()

            status, body = await asyncio.to_thread(get, "/.well-known/yea")
            assert status == 200 and b'"kind":"BRIEF"' in body
            assert (await asyncio.to_thread(get, "/yea", b"x" * ((1 << 20) + 10)))[0] == 413
        finally:
            http.close()
            await http.wait_closed()

    run(go())


def test_m7_a_huge_unknown_name_doesnt_burn_cpu_on_suggestions():
    """[M7] A 300k-character unknown capability answers fast: no edit-distance search over it."""
    from yea.validate import closest

    assert closest("a" * 300_000, ["pay.send"]) is None  # the guard itself, deterministically
    svc = pay_service()
    for i in range(20):  # more names to compare against, so a missing guard costs seconds
        svc.ask(f"pay.look{i}")(lambda ctx: None)

    async def go():
        t = time.perf_counter()
        r = await svc.handle({"yea": 1, "id": "x", "verb": "ASK", "capability": "a" * 300_000})
        return r, time.perf_counter() - t

    r, took = run(go())
    assert r["kind"] == "ERROR" and took < 0.5


def test_u4_a_block_that_repeats_a_total_counts_each_commit_once():
    """[U4] Two identical total caveats in one block: 60 then 30 of 100 both fit."""
    limit = {"of": "spend", "max": 100, "scale": 2, "unit": "USD"}

    async def go():
        c = client(pay_service(), {"total": limit}, {"total": limit})
        assert (await c.commit(await proposal(c, "a", 60))).kind == "RECEIPT"
        assert (await c.commit(await proposal(c, "b", 30))).kind == "RECEIPT"

    run(go())


def test_a9_reserve_all_releases_what_it_made_when_the_store_fails_part_way():
    """[A9] The second reservation fails: the first is released, so nothing stays counted."""
    store = MemoryStore()

    class Failing(MemoryStore):
        async def reserve(self, k, amount, max):
            if k.of == "spend":
                raise RuntimeError("the approval store is busy")
            return await store.reserve(k, amount, max)

        async def release(self, r):
            return await store.release(r)

    async def go():
        with pytest.raises(RuntimeError, match="busy"):
            await reserve_all(Failing(), ((LedgerKey("B", "emails"), 1, 5), (LedgerKey("B", "spend"), 1, 5)))
        assert await store.used(LedgerKey("B", "emails")) == 0

    run(go())


NOW = 1_790_000_000
INVALID_STATE = Outcome("refuse", "this approval is invalid, expired, already used, or for another call", again=True)
ACCEPT = {"action": "accept", "content": {"confirm": "approve"}}


def asking_call(input: dict | None = None, now: int = NOW) -> JobCall:
    """A refund call outside any policy, from a client that can ask: its first round asks."""
    async def plan():
        return [Plan("Refund", [], apply=lambda c: None, risk="low")]
    return JobCall(JobTool("refund"), input or {"who": "Chen"}, plan, "", now, Policy(server_key="S"), True)


async def asked_state(store) -> dict:
    o = await job_call(asking_call(), store)
    assert o.kind == "ask" and o.state is not None
    return o.state


def test_a5_a_decline_a_stale_state_or_another_input_never_runs_anything():
    """[A5] Through the job call session, as ts/test/security.test.ts."""
    async def go():
        store = MemoryStore()
        declined = Retry(await asked_state(store), {"action": "decline", "content": {"confirm": "approve"}})
        assert await job_call(asking_call(), store, declined) == Outcome("refuse", "not approved")
        other = Retry(await asked_state(store), ACCEPT)
        assert await job_call(asking_call({"who": "Ana"}), store, other) == INVALID_STATE
        state = await asked_state(store)
        assert await job_call(asking_call(now=state["exp"]), store, Retry(state, ACCEPT)) == INVALID_STATE

    run(go())


def test_a18_a_state_sent_again_runs_nothing_whatever_its_answer():
    """[A18] Every retry consumes its state's nonce: resent, approved or declined, it runs nothing."""
    async def go():
        store = MemoryStore()
        approved = Retry(await asked_state(store), ACCEPT)
        assert (await job_call(asking_call(), store, approved)).kind == "run"
        assert await job_call(asking_call(), store, approved) == INVALID_STATE
        declined = await asked_state(store)
        assert await job_call(asking_call(), store, Retry(declined, {"action": "decline"})) == Outcome(
            "refuse", "not approved")
        assert await job_call(asking_call(), store, Retry(declined, ACCEPT)) == INVALID_STATE

    run(go())


# [A38] A consent on the call (``yea_consent``) is checked exactly as one from the store (#358).
# The server key the a38/a37 calls run under (not the undo-window tests' SERVER, below).
CONSENT_SERVER = key_from_seed(bytes([6]) * 32)
# The store the a38 consents bind (SPEC-approval §6); ``_store()`` has this id.
CONSENT_STORE = "yea-test-store-aaaaaaa"
_REFUND = Plan("Refund 30.00 USD to Chen", [], apply=lambda c: None, risk="low", undo_window=60)
_CREDIT = Plan("Give Chen store credit", [], apply=lambda c: None, risk="low", undo_window=60)
_REFUND_TOOL = JobTool("refund", revert=lambda r: None)
_REFUND_HASH = hash_plans(_REFUND_TOOL, {"who": "Chen"}, [_REFUND])[0].plan_hash
# A policy that would run the refund without asking.
_RUNS_REFUNDS = issue_grant(PRINCIPAL, CONSENT_SERVER.public, [{"can": ["refund"]}, {"risk": "low"}, {"exp": NOW + 3600}]).encode()
_NOT_SIGNED = "it isn't signed by the pinned principal for this tool at this server"
_NO_PLAN = ("it approves none of these plans; if the person approved this exact request, this server may have "
            "restarted since or not be the one that asked, or the code they were given may have been altered")


def _store() -> MemoryStore:
    return MemoryStore(store_id=CONSENT_STORE)


def _consent(by=PRINCIPAL, to: str = CONSENT_SERVER.public, svc: str | None = None, can: str = "refund",
             exp: int = NOW + 600) -> str:
    """A consent for the refund as ``yea approve`` signs one, with ``by``, ``to``, ``svc``, ``can`` or
    ``exp`` changed."""
    return issue_grant(by, to, [{"svc": [svc or CONSENT_SERVER.public]}, {"verbs": ["COMMIT"]}, {"can": [can]},
                                {"only": consent_hash_of(_REFUND_HASH, "approve", CONSENT_STORE)}, {"exp": exp}], iat=NOW).encode()


def _carrying(consent: str | None, now: int = NOW, plans: tuple = (_REFUND,), principal: str | None = PRINCIPAL.public,
              unpinned: str | None = None, tool: JobTool = _REFUND_TOOL) -> JobCall:
    """A refund call carrying ``consent``, from a client that can't ask, under a policy that would run it."""
    async def plan():
        return list(plans)
    policy = load_policy(_RUNS_REFUNDS, CONSENT_SERVER.public, principal, Tightening((), "high"))
    return JobCall(tool, {"who": "Chen"}, plan, "", now, policy, False, unpinned=unpinned, consent=consent)


def _refused_for(why: str):
    return lambda o: (o.kind, o.why) == ("consent-codes", f"the consent passed as yea_consent can't be used: {why}")


def test_a38_a_consent_on_the_call_runs_its_plan_once_and_a_second_use_is_refused():
    async def go():
        store, token = _store(), _consent()
        # The newline a terminal copy adds doesn't matter: the signature covers only the token.
        first = await job_call(_carrying(token + "\n"), store)
        assert (first.kind, first.how) == ("run", "approved")
        assert _refused_for("it was already used")(await job_call(_carrying(token), store))

    run(go())


def test_a38_once_used_on_the_call_a_stored_copy_of_the_consent_is_used_too():
    async def go():
        store, token = _store(), _consent()
        assert (await job_call(_carrying(token), store)).how == "approved"
        await store.put_consent(_REFUND_HASH, token)
        plain = _carrying(None)
        no_policy = JobCall(plain.tool, plain.input, plain.plan, "", NOW, Policy(None, PRINCIPAL.public, CONSENT_SERVER.public),
                            False)
        assert (await job_call(no_policy, store)).kind == "consent-codes"

    run(go())


def _altered() -> str:
    """The consent with its ``exp`` moved and the signature kept."""
    g = decode_grant(_consent())
    b = g.blocks[0]
    return Grant(({**b, "p": {**b["p"], "caveats": [*b["p"]["caveats"][:4], {"exp": NOW + 9999}]}},)).encode()


@pytest.mark.parametrize("name, token, why, now", [
    ("forged", lambda: _consent(by=AGENT), _NOT_SIGNED, NOW),
    ("issued to another key", lambda: _consent(to=AGENT.public), _NOT_SIGNED, NOW),
    ("altered", _altered, _NOT_SIGNED, NOW),
    ("expired", lambda: _consent(), "it has expired", NOW + 600),
    ("for another server", lambda: _consent(svc=AGENT.public), _NOT_SIGNED, NOW),
    ("for another tool", lambda: _consent(can="delete_branch"), _NOT_SIGNED, NOW),
    ("mangled", lambda: _consent()[:40], "it isn't a consent from yea approve", NOW),
    ("empty", lambda: "", "it isn't a consent from yea approve", NOW),
    ("the policy grant", lambda: _RUNS_REFUNDS, "it isn't a consent from yea approve", NOW),
])
def test_a38_a_bad_consent_on_the_call_runs_nothing_and_never_falls_through_to_the_policy(name, token, why, now):
    """The policy alone would run the refund: a refused consent never falls through to it."""
    assert _refused_for(why)(run(job_call(_carrying(token(), now=now), _store()))), name


def test_a38_a_consent_on_the_call_for_one_plan_doesnt_commit_another():
    o = run(job_call(_carrying(_consent(), plans=(_CREDIT,)), _store()))
    assert _refused_for(_NO_PLAN)(o)


def test_a38_a_consent_on_the_call_signed_for_another_phrase_says_the_code_may_have_been_altered():
    tool = JobTool("refund", revert=lambda r: None, confirm_with=lambda hp, input: "refund Chen")
    assert _refused_for(_NO_PLAN)(run(job_call(_carrying(_consent(), tool=tool), _store())))


def test_a38_a_consent_consumed_in_one_store_runs_nothing_in_another_with_the_same_key():
    """Two servers with one key and their own stores (a connector's stdio and HTTP sides), or one
    server restarted on a MemoryStore: the consent binds the store it was issued for."""
    async def go():
        token = _consent()
        first = await job_call(_carrying(token), _store())
        assert (first.kind, first.how) == ("run", "approved")
        assert _refused_for(_NO_PLAN)(await job_call(_carrying(token), MemoryStore()))

    run(go())


class _IdStore(MemoryStore):
    """A custom store whose ``store_id()`` gives ``id``, whatever it is."""
    def __init__(self, id):
        super().__init__(store_id=CONSENT_STORE)
        self._bad = id

    async def store_id(self):
        return self._bad


_NOT_IDS = [None, "", "x" * 21, "x" * 36]


@pytest.mark.parametrize("bad", _NOT_IDS, ids=["None", "empty", "21 characters", "36 characters"])
def test_a38_a_store_whose_id_isnt_one_runs_nothing_and_issues_no_code_even_with_a_storeless_consent(bad):
    """A custom store whose ``store_id()`` gives no id would issue codes that bind no store, as before
    the store binding, and accept a consent that binds none: once in every such store."""
    ran = []
    refund = Plan(_REFUND.summary, [], apply=lambda c: ran.append(c), risk="low", undo_window=60)
    storeless = issue_grant(PRINCIPAL, CONSENT_SERVER.public, [
        {"svc": [CONSENT_SERVER.public]}, {"verbs": ["COMMIT"]}, {"can": ["refund"]},
        {"only": sha256_b64url(canonical({"plan": _REFUND_HASH, "phrase": "approve"}).encode())}, {"exp": NOW + 600},
    ], iat=NOW).encode()
    carried = _carrying(storeless, plans=(refund,))
    # No consent and no policy: the call would otherwise ask, with codes.
    asked = JobCall(carried.tool, carried.input, carried.plan, "", NOW,
                    Policy(None, PRINCIPAL.public, CONSENT_SERVER.public), False)
    for call in (carried, asked):
        with pytest.raises(StoreError, match=r"this store's store_id\(\) isn't a store id"):
            run(job_call(call, _IdStore(bad)))
    assert ran == []


@pytest.mark.parametrize("bad", _NOT_IDS, ids=["None", "empty", "21 characters", "36 characters"])
def test_a38_no_consent_code_binds_a_store_id_that_isnt_one(bad):
    hp = hash_plans(_REFUND_TOOL, {"who": "Chen"}, [_REFUND])[0]
    with pytest.raises(ValueError, match="not a store id"):
        job_consent_code(CONSENT_SERVER.public, PRINCIPAL.public, {"who": "Chen"}, hp, "approve", bad, NOW)


def test_a38_a_consent_on_the_call_counts_for_nothing_without_a_pinned_principal():
    o = run(job_call(_carrying(_consent(), principal=None, unpinned="YEA_PRINCIPAL_PUB is not set"), _store()))
    assert _refused_for("YEA_PRINCIPAL_PUB is not set")(o) and o.codes == []


def _mode_0(path: Path) -> None:
    path.write_text("pg1.x")
    path.chmod(0)


def _symlink(path: Path) -> None:
    (path.parent / "elsewhere").write_text("pg1.x")
    path.symlink_to(path.parent / "elsewhere")


_NOT_ROOT = hasattr(os, "getuid") and os.getuid() != 0


@pytest.mark.parametrize("plant, why", [
    pytest.param(_mode_0, "EACCES", id="a file the server may not read",
                 marks=pytest.mark.skipif(not _NOT_ROOT, reason="needs a user that file modes apply to")),
    pytest.param(lambda p: os.mkfifo(p), "not a regular file", id="a FIFO, which never blocks the read",
                 marks=pytest.mark.skipif(not hasattr(os, "mkfifo"), reason="no FIFOs here")),
    pytest.param(_symlink, "ELOOP", id="a symlink, never followed, even to a consent"),
    pytest.param(lambda p: p.write_text("x" * 65537), "over 64 KiB", id="a file over 64 KiB"),
])
def test_a37_an_unreadable_consent_in_the_store_asks_again_with_no_fs_error_in_the_result(tmp_path, capsys, plant, why):
    """[A37] What an agent with the store could plant under the plan's hash (#358): the call asks, as
    with no consent, and the reason reaches stderr only."""
    store = FileStore(tmp_path)
    hp = hash_plans(JobTool("refund"), {"who": "Chen"}, [Plan("Refund", [], apply=lambda c: None, risk="low")])[0]
    planted = tmp_path / "consents" / hp.plan_hash
    planted.parent.mkdir()
    plant(planted)
    try:
        call = asking_call()
        o = run(job_call(JobCall(call.tool, call.input, call.plan, "", NOW,
                                 Policy(None, PRINCIPAL.public, CONSENT_SERVER.public), False), store))
        assert o.kind == "consent-codes" and why not in repr(o)
        assert f"yea: the consent at {planted} can't be read ({why}), so it counts as absent" in capsys.readouterr().err
    finally:
        planted.chmod(0o600)


@pytest.mark.parametrize("bad", [
    {"each": {"of": "spend", "max": 1, "scale": 19, "unit": "USD"}},
    {"total": {"of": "spend", "max": -1}},
    {"each": {"of": "spend", "max": 1, "currency": "USD"}},
    {"per": {"max": 1, "currency": "USD"}},
], ids=["scale 19", "negative max", "old currency", "unknown caveat"])
def test_u3_malformed_limits_fail_closed_on_commit(bad):
    """[U3] End to end: a COMMIT under a malformed each/total (or an unknown caveat) is forbidden."""
    async def go():
        c = client(pay_service(), bad)
        return await c.commit(await proposal(c, "a", 1))

    r = run(go())
    assert r.kind == "ERROR" and r.code == "forbidden"


@pytest.mark.parametrize("risk", ["critical", "toString", None])
def test_u8_a_risk_caveat_fails_closed_hard_on_an_unknown_proposal_risk(risk):
    """[U8] critical, a prototype name, or a missing risk (None) on the proposal: forbidden."""
    from yea.grants import GrantContext, verify_grant

    g = issue_grant(PRINCIPAL, AGENT.public, [{"risk": "high"}]).encode()
    r = verify_grant(g, [PRINCIPAL.public], AGENT.public,
                     GrantContext("s", "COMMIT", "x", 1_790_000_000, {"hash": "h", "risk": risk}))
    assert not r.ok and r.code == "forbidden"


@pytest.mark.parametrize("plan_risk,default", [
    ("critical", None), ("toString", None), (None, "critical"), ("critical", "low"),
])
def test_u10_a_plan_with_an_unknown_risk_never_becomes_a_proposal(plan_risk, default, caplog):
    """[U10] An unknown risk on the plan or as the intent's default refuses the INTENT. (TS's null
    cases don't apply: in Python None means absent, so the default or "low" is used.)"""
    svc = Service("bad", "Bad", "bad", trust=[PRINCIPAL.public])
    svc.intent("bad.do", "do", risk=default)(lambda ctx: Plan("do it", [], apply=lambda c: None, risk=plan_risk))
    r = run(client(svc).intent("bad.do", {}))
    assert r.kind == "ERROR" and r.code == "internal" and "proposals" not in r.frame
    assert "unknown risk" in caplog.text  # the service's log says why (TS: onError)


@pytest.mark.parametrize("cav", [{"risk": "toString"}, None, {"risk": "constructor"}])
def test_l10_l15_odd_caveat_values_fail_closed(cav):
    """[L10/L15] A prototype-name risk or a None caveat: forbidden, never ok, never a crash."""
    from yea.grants import GrantContext, verify_grant

    g = issue_grant(PRINCIPAL, AGENT.public, [cav]).encode()
    r = verify_grant(g, [PRINCIPAL.public], AGENT.public,
                     GrantContext("s", "COMMIT", "x", 1_790_000_000, {"hash": "h", "risk": "high"}))
    assert not r.ok and r.code == "forbidden"


def test_a1_undo_ids_outside_the_generated_format_never_reach_the_store(tmp_path):
    """[A1] Path-like, short, wrong-prefix and non-string ids are "no such receipt", and the store
    directory stays empty; the store itself refuses an unsafe name (TS throws; Python answers None)."""
    from yea.approval import undo_receipt
    from yea.store import FileStore

    store = FileStore(tmp_path / "store")
    (tmp_path / "store" / "receipts").mkdir(parents=True)  # so store/receipts/../../x.json resolves
    # A receipt-shaped file where "../../x" would land, so a missing format check would find it
    # rather than a missing file.
    (tmp_path / "x.json").write_text('{"id": "r_AAAAAAAAAAAA", "service": "S", "sub": "", "tool": "t", '
                                     '"undo": {"until": 1900000000}, "summary": "planted", "effects": []}')
    reverted = []

    async def go():
        for rid in ("../../x", "r_../../../etc", "r_short", "x_AAAAAAAAAAAA", 42, None):
            out = await undo_receipt(store, rid, "S", "", 1_790_000_000, reverted.append)
            assert (out.kind, out.why) == ("refused", "no such receipt"), rid
        assert await store.get_receipt("../../x") is None  # refused before any path is built

    run(go())
    assert reverted == []
    assert [f for f in (tmp_path / "store").rglob("*") if f.is_file()] == []  # nothing written


@pytest.mark.parametrize("bad", ["critical", "toString", "__proto__", "", 1, None])
def test_a14_an_unknown_risk_ranks_above_every_known_one(bad):
    """[A14] Always out of band and over every ceiling; a bad floor or ceiling passes nothing."""
    from yea.risk import at_least, exceeds

    for k in ("low", "medium", "high"):
        assert at_least(bad, k) and exceeds(bad, k) and at_least(k, bad) and exceeds(k, bad)
    assert not at_least("medium", "high") and not exceeds("medium", "high") and exceeds("high", "medium")


RLO, ESC, TAG_A = "‮", "\x1b", "\U000e0041"
PROPOSAL = {"id": "p_1", "capability": "pay.send", "summary": "pay a", "effects": [{"op": "create", "target": "payment/a"}],
            "uses": {"spend": quantity(100, scale=2, unit="USD")}, "risk": "low", "undo": {"window": 3600},
            "expires": 1_790_000_000, "hash": "h"}


def test_c4_the_consent_view_escapes_service_text_and_never_shows_data():
    """[C4] Summary and effect fields escaped, the uses · risk · undo · expires line, three lines,
    each already printable, and ``data`` never shown."""
    from yea.approve import consent_view
    from yea.text import printable

    lines = consent_view({**PROPOSAL, "summary": "pay a\n  + create payment/b\x1b[2K",
                          "effects": [{"op": "create", "target": f"payment/a{RLO}", "detail": "x\ry", "to": f"q\x85{RLO}"}],
                          "data": {"note": "SECRET-UNHASHED"}})
    assert lines[0] == "[p_1] pay a\\u{a}  + create payment/b\\u{1b}[2K"
    assert lines[1].startswith("  + create payment/a\\u{202e}") and "— x\\u{d}y" in lines[1]
    assert lines[2].startswith("  uses: spend ") and " · risk: low · undo: " in lines[2] and " · expires: " in lines[2]
    assert len(lines) == 3 and "SECRET-UNHASHED" not in "\n".join(lines)
    assert all(printable(line) == line for line in lines)


def test_s4_untrusted_lens_escapes_params_named_data_or_result_and_quoted_values_once():
    """[S4] A BRIEF param named data or result, effect sides, ANSWER data and a receipt result:
    each escaped, each one line, and a quoted value escaped only once."""
    from yea.lens import untrusted_lens

    brief = untrusted_lens({"yea": 1, "id": "-", "re": "-", "kind": "BRIEF", "service": {"id": "s", "name": "S", "summary": "x"},
                            "capabilities": [{"kind": "act", "name": "a.b", "summary": "s",
                                              "params": {"data": "str\n  + create evil", "result": {"x": "y\nz"}}}]})
    assert len(brief.split("\n")) == 3 and "data: str\\u{a}  + create evil" in brief

    def proposals(effect):
        return untrusted_lens({"yea": 1, "id": "-", "re": "-", "kind": "PROPOSALS", "proposals": [{**PROPOSAL, "effects": [effect]}]})

    assert '~ update t: "a\\nb" → "c\\u001b"' in proposals({"op": "update", "target": "t", "from": "a\nb", "to": f"c{ESC}"})
    assert '~ update t: - → "x\\u{202e}\\u{85}\\u{e0041}"' in proposals({"op": "update", "target": "t", "to": f"x{RLO}\x85{TAG_A}"})

    answer = untrusted_lens({"yea": 1, "id": "-", "re": "-", "kind": "ANSWER", "data": {"note": f"a\n  + create evil{RLO}"}})
    assert answer == 'note: "a\\n  + create evil\\u{202e}"'

    done = untrusted_lens({"yea": 1, "id": "-", "re": "-", "kind": "RECEIPT", "receipt": {
        "id": "r_12345678", "proposal": "p_1", "summary": "paid", "at": 1_790_000_000, "effects": [], "undo": None,
        "result": f"r\n✓ forged{TAG_A}"}})
    assert len(done.split("\n")) == 2 and 'result: "r\\n✓ forged\\u{e0041}"' in done


def test_an_undo_that_finished_after_the_done_check_is_not_claimed_again(tmp_path, monkeypatch):
    """A revert that marks done and releases its claim between another caller's done check and its
    claim must not be claimed (and so run) a second time."""
    import yea.store.file_store as fs
    from yea.store import FileStore

    store = FileStore(tmp_path / "store")
    rid = "r_AAAAAAAAAAAA"
    real = fs._create_excl

    def finish_then_create(path, text=""):
        if path.name.endswith(".claim"):
            real(path.with_name(f"{rid}.done"))  # the other revert finished just now
        return real(path, text)

    monkeypatch.setattr(fs, "_create_excl", finish_then_create)
    assert run(store.claim_undo(rid)) is False
    assert not (tmp_path / "store" / "undo" / f"{rid}.claim").exists()  # its claim was released


class _HostileReplies:
    """A transport that answers every request with one fixed frame, as a hostile service would."""

    def __init__(self, frame):
        self.frame = frame

    async def request(self, frame, on_event):
        from yea.client import Reply

        return Reply({**self.frame, "re": frame["id"]})

    async def close(self):
        pass


def _hostile_proposals(**p):
    return {"yea": 1, "id": "s1", "kind": "PROPOSALS", "proposals": [
        {"id": "p_x", "capability": "x.do", "summary": "do it", "effects": [], "risk": "low", "undo": None,
         "expires": 1, "hash": "h", **p}]}


@pytest.mark.parametrize("uses", [
    {"s": {"amount": -5, "scale": 2}}, {"s": None}, None, {"s": {"amount": 1, "unit": "X\n  ~ update fake"}},
], ids=["negative", "null quantity", "null uses", "newline in the unit"])
def test_u6_a_reply_with_a_malformed_uses_is_invalid_and_never_rendered(uses):
    """[U6] Through Client.intent: bad_frame, and the hostile unit's fake line never reaches the Lens."""
    r = run(Client(_HostileReplies(_hostile_proposals(uses=uses))).intent("x.do", {}))
    assert r.kind == "ERROR" and r.code == "bad_frame" and "update fake" not in r.lens


@pytest.mark.parametrize("risk", ["critical", "toString", None, "absent"])
def test_u9_a_proposal_with_an_unknown_or_missing_risk_is_invalid(risk):
    """[U9] Through Client.intent: bad_frame for an unknown risk, a null one, and one left out."""
    frame = _hostile_proposals(risk=risk)
    if risk == "absent":
        del frame["proposals"][0]["risk"]
    r = run(Client(_HostileReplies(frame)).intent("x.do", {}))
    assert r.kind == "ERROR" and r.code == "bad_frame"


def test_plan_and_run_never_see_an_unauthenticated_agent_member():
    """SPEC §4.1: `agent` is informational only, so a frame's `agent` isn't handed to code that could authorize on it (#190)."""
    seen = []
    svc = Service("svc", "Svc", "svc", trust=[PRINCIPAL.public])

    @svc.ask("svc.who", "who")
    def who(ctx):
        seen.append(ctx)
        return {"ok": True}

    @svc.intent("svc.do", "do it")
    def do(ctx):
        seen.append(ctx)
        return Plan("do it", [create("thing/1")], apply=lambda c: None)

    claimed = {"name": "admin", "key": PRINCIPAL.public}

    async def go():
        for verb, name in (("ASK", "svc.who"), ("INTENT", "svc.do")):
            r = await svc.handle({"yea": 1, "id": verb, "verb": verb, "capability": name, "agent": claimed}, lambda e: None)
            assert r["kind"] != "ERROR", r

    run(go())
    assert len(seen) == 2
    for ctx in seen:
        assert not hasattr(ctx, "agent") and claimed not in vars(ctx).values()


def test_lens_key_order_survives_hostile_and_mixed_keys():
    """An integer-like key thousands of digits long is an ordinary key, not a crash (int() refuses
    strings past 4300 digits), and 1 beside "1" doesn't make the sort compare an int with a str."""
    from yea import lean
    from yea._json import compact, js_keys

    huge = "1" * 5000
    assert js_keys({"b": 1, huge: 2, "3": 3}) == ["3", "b", huge]
    assert lean({"b": 1, huge: 2}).splitlines()[0] == "b: 1"
    assert compact({"a": 1, "4294967295": 2, "7": 3}) == '{"7":3,"a":1,"4294967295":2}'
    assert js_keys({1: "int", "1": "str", "0": 0}) == ["0", 1, "1"]


def test_budget_elides_ties_in_the_same_order_as_ts():
    """Candidates are collected in Object.entries order, so a tie cuts the same path first
    (TS gives data.1 then data.b for this frame)."""
    from yea.budget import MemoryHandleStore, fit

    data = json.loads('{"b":"' + "x " * 400 + '","1":"' + "y " * 400 + '"}')
    out = fit({"yea": 1, "id": "s1", "re": "c1", "kind": "ANSWER", "data": data}, 500, MemoryHandleStore())
    assert [m["path"] for m in out["more"]] == ["data.1", "data.b"]


def test_invalid_params_lists_problems_in_the_same_order_as_ts():
    """The model reads this message: schema and params are walked in Object.keys order, as in TS."""
    from yea.errors import YeaError
    from yea.validate import validate_params

    with pytest.raises(YeaError) as e:
        validate_params({"a": "string"}, json.loads('{"a":"x","b":1,"2":1,"1":1}'))
    assert e.value.message == "unknown param `1`; unknown param `2`; unknown param `b`"
    with pytest.raises(YeaError) as e:
        validate_params(json.loads('{"b":"string","3":"int"}'), {})
    assert e.value.message == "missing `3` (int); missing `b` (string)"


def test_g2_a_deeply_nested_grant_token_is_unauthorized_not_an_exception():
    """A token nested past the recursion limit made json.loads raise RecursionError out of
    decode_grant, so verify_grant (which never raises) did. It is not valid JSON: unauthorized."""
    depth = 100_000
    token = "pg1." + b64url_encode(("[" * depth + "]" * depth).encode())
    with pytest.raises(ValueError, match="not valid b64url JSON"):
        decode_grant(token)
    ctx = GrantContext("pay", "ASK", "pay.send", int(time.time()))
    v = verify_grant(token, [PRINCIPAL.public], AGENT.public, ctx)
    assert (v.ok, v.code, v.reason) == (False, "unauthorized", "malformed grant: not valid b64url JSON")


_LENS_KINDS = {
    "BRIEF": {"service": {"id": "s", "name": "S", "summary": "x"},
              "capabilities": [{"kind": "ask", "name": "s.q", "params": {"a": "string"}}]},
    "ANSWER": {"data": {"a": 1}},
    "PROPOSALS": {"proposals": [{"id": "p_1", "summary": "s", "effects": [{"op": "create", "target": "t"}]}]},
    "CLARIFY": {"question": "q", "options": [{"label": "a"}]},
    "RECEIPT": {"receipt": {"id": "r_1", "summary": "s", "effects": [{"op": "send", "target": "t"}]}, "auto": True},
    "ERROR": {"code": "bad", "message": "m", "fix": [{"say": "x", "params": {}}], "need": ["a"],
              "consent": {"hash": "h", "summary": "s"}},
    "EVENT": {"message": "m"},
}
_ABSENT = object()


@pytest.mark.parametrize("kind", list(_LENS_KINDS))
def test_lens_never_raises_on_a_malformed_frame(kind):
    """#188: a service that sends any member as any type gets a rendering, not an exception."""
    from yea import lens

    members = _LENS_KINDS[kind]
    for k in [*members, "more"]:
        for w in (_ABSENT, None, 5, "x", True, [], {}, [5], [{}]):
            frame = {"yea": 1, "id": "s1", "re": "c1", "kind": kind, **members}
            if w is _ABSENT:
                frame.pop(k, None)
            else:
                frame[k] = w
            assert isinstance(lens(frame), str), (k, w)


def test_lens_never_raises_on_a_malformed_nested_member_or_a_deep_param_schema():
    """#188 review: nested members too (an auto receipt's effects, an effect's op and from, a proposal's
    expires, a more count), and a param schema deeper than the limit falls back to the unknown kind."""
    from yea import lens

    def frame(kind, **members):
        return {"yea": 1, "id": "s1", "re": "c1", "kind": kind, **members}

    def effect(e):
        return frame("PROPOSALS", proposals=[{"id": "p", "summary": "s", "effects": [e]}])

    for w in (None, 5, "x", True, [], {}, [5], [{}], "constructor", "__proto__"):
        for f in (
            frame("RECEIPT", receipt={"id": "r", "summary": "s", "effects": w}, auto=True),
            effect({"op": w, "target": "t"}),
            effect({"op": "update", "target": "t", "from": w}),
            frame("PROPOSALS", proposals=[{"id": "p", "summary": "s", "effects": [], "expires": w}]),
            frame("ANSWER", data=1, more=[{"remaining": w, "path": "p", "handle": "h", "est": 1}]),
        ):
            assert isinstance(lens(f), str), (f, w)
    for v in (None, 5, "x", []):
        assert lens(v) == "{}"
    params = "string"
    for _ in range(250):
        params = {"a": params}
    deep = frame("BRIEF", service={"id": "s", "name": "S"}, capabilities=[{"kind": "ask", "name": "s.q", "params": params}])
    assert lens(deep).startswith("kind: BRIEF")


def test_lens_never_overflows_the_stack_on_a_deeply_nested_value():
    """#213: a value nested far past the recursion limit renders, cut to "…" 64 levels down, in every
    place Lens renders a value."""
    from yea.lens import lean, lens, safe_effect_line, scalar, untrusted_lens
    from yea.text import one_line

    def nest(wrap):
        v = 1
        for _ in range(20_000):
            v = wrap(v)
        return v

    def frame(kind, **members):
        return {"yea": 1, "id": "s1", "re": "c1", "kind": kind, **members}

    for deep in (nest(lambda v: {"a": v}), nest(lambda v: [v])):
        frames = (
            frame("ANSWER", data=deep),
            frame("PROPOSALS", proposals=[{"id": "p", "summary": "s", "effects": [], "data": deep}]),
            frame("RECEIPT", receipt={"id": "r", "summary": "s", "result": deep}),
            frame("ERROR", code="c", message="m", fix=[{"say": "try", "params": {"x": deep}}], need=[deep]),
            frame("NEW", deep=deep),
        )
        for f in frames:
            assert '"…"' in lens(f)
            assert '"…"' in untrusted_lens(f)
        assert '"…"' in lean(deep)
        assert '"…"' in lean({"items": [deep]})
        assert '"…"' in scalar(deep)
        assert "…" in repr(one_line(deep))
        assert '"…"' in safe_effect_line({"op": "update", "target": "t", "from": deep})


def test_approval_never_covers_content_lens_cuts():
    """#213: a proposal (without data) or a plan's summary, effects and uses nested past 32 levels,
    itself being the first, is never shown for approval: Lens would cut part of what the person signs.
    The proposal or plan is level 0, an effect 2 and its ``to`` 3, so ``buried(n)`` puts the innermost
    object at n + 3: 28 is the deepest a person can approve."""
    import pytest

    from yea import proposal_hash
    from yea.approval.plan import JudgedPlan, plan_preimage
    from yea.approve import check_proposal
    from yea.lens import safe_effect_line
    from yea.service.plan import Plan

    def buried(levels):
        v = {"forward_to": "attacker@evil.test"}
        for _ in range(levels):
            v = {"settings": v}
        return v

    def effect(levels):
        return {"op": "update", "target": "settings", "to": buried(levels)}

    def hashed(p):
        return {**p, "hash": proposal_hash(p)}

    base = {"id": "p1", "capability": "s.set", "risk": "low", "expires": 1_790_000_000}

    def proposal(levels):
        return hashed({**base, "summary": "Update settings", "effects": [effect(levels)]})

    too_deep = "the proposal is nested too deep to show in full"
    assert check_proposal(proposal(28)) is None
    assert check_proposal(proposal(29)) == too_deep
    assert check_proposal(proposal(300)) == too_deep
    for p in (
        {**base, "summary": buried(40), "effects": []},
        {**base, "summary": "s", "effects": {"a": buried(40)}},
        {**base, "summary": "s", "effects": [], "undo": {"window": 60, "x": buried(40)}},
    ):
        assert check_proposal(hashed(p)) == too_deep

    def plan(levels, wrap=list):
        return Plan("Update settings", wrap([effect(levels)]), apply=lambda: None)

    assert plan_preimage({}, JudgedPlan("t", plan(28), "low", False))["tool"] == "t"
    for p in (plan(29), plan(29, tuple)):
        with pytest.raises(ValueError, match="nested past 32 levels"):
            plan_preimage({}, JudgedPlan("t", p, "low", False))

    shown = safe_effect_line(proposal(28)["effects"][0])
    assert "attacker@evil.test" in shown and "…" not in shown


def test_the_verified_request_names_the_holder_only_from_a_proof_it_verified():
    """Mirrors 'the verified request (#278)' in TS: the holder, and so an auto INTENT's replay key,
    come only from a proof the verified request checked (#157)."""
    svc = pay_service()
    now = int(time.time())
    frame = {"yea": 1, "id": "f1", "verb": "INTENT", "capability": "pay.send", "params": {"to": "a", "amt": 1}, "auto": True}
    grants = [issue_grant(PRINCIPAL, AGENT.public, []).encode()]
    proof = sign_proof(AGENT, "pay", "INTENT", "auto:pay.send:f1", now)
    forged = {"key": AGENT.public, "ts": now, "sig": "A" * 86}

    ok = verify_request(svc.state, {**frame, "grants": grants, "proof": proof}, 2000)
    assert isinstance(ok, VerifiedIntent) and ok.auto is not None
    assert (ok.holder, ok.principal, ok.auto.replay) == (AGENT.public, PRINCIPAL.public, (f"{AGENT.public}:f1", now))
    for grants_, code in ((grants, "unauthorized"), ({}, "bad_frame"), ([None], "bad_frame")):
        with pytest.raises(YeaError) as e:
            verify_request(svc.state, {**frame, "grants": grants_, "proof": forged}, 2000)
        assert e.value.code == code
    # With no grants the forged proof is never read: anonymous, with no replay key.
    anon = verify_request(svc.state, {**frame, "grants": [], "proof": forged}, 2000)
    assert isinstance(anon, VerifiedIntent) and anon.auto is not None
    assert (anon.holder, anon.principal, anon.auto.replay) == (None, None, None)


def test_m4b_a_non_requester_whose_grant_would_need_consent_gets_forbidden():
    """[M4b] Who may commit is checked before the limits (#278), so another agent never gets a consent
    request for a proposal it could not commit even with the consent."""
    other = key_from_seed(bytes([3]) * 32)
    each = {"each": {"of": "spend", "max": 10, "scale": 2, "unit": "USD"}}

    async def go():
        svc = pay_service()
        mine = await proposal(client(svc), "shop", 50)
        # The same limit asks the requester for consent: the grant would need it.
        own = await client(svc, each).commit(mine)
        assert (own.kind, own.code) == ("ERROR", "consent_required")
        thief = Client(local(svc), key=other, grants=[issue_grant(PRINCIPAL, other.public, [each]).encode()])
        r = await thief.commit(mine)
        assert (r.kind, r.code, r.message, r.get("consent")) == (
            "ERROR", "forbidden", "only the agent that requested this proposal can commit it", None)

    run(go())


# Mirrors 'an INTENT no grant authorized (#287)' in TS: an INTENT can carry grants and a valid proof
# and still be authorized by none of them, such as a COMMIT-only grant. It then plans with no
# principal, so it never auto-commits, and only a principal's consent commits its proposal.
COMMIT_ONLY = [{"verbs": ["COMMIT"]}]
OTHER = key_from_seed(bytes([4]) * 32)  # another principal the service trusts
OTHER_AGENT = key_from_seed(bytes([5]) * 32)


def _undoable(applied, require_grants=False):
    """A service whose one intent is undoable, recording the principal of every ``apply``."""
    svc = Service("v", "V", "v", trust=[PRINCIPAL.public, OTHER.public], require_grants=require_grants)

    def apply(ctx):
        applied.append(ctx.principal)

    @svc.intent("v.do", "do")
    def do(ctx):
        return Plan("do it", [create("thing/1")], apply=apply, revert=lambda ctx: None)

    return svc


def _as(svc, *grants):
    return Client(local(svc), key=AGENT, grants=[g.encode() for g in grants])


def _proposal_of(r):
    assert r.kind == "PROPOSALS", r.lens
    return r.proposals[0]


def _consent_of(r):
    assert (r.kind, r.get("code")) == ("ERROR", "consent_required"), r.lens
    return r.consent


def test_a_commit_only_grant_plus_auto_gives_proposals_and_a_plain_commit_needs_consent():
    async def go():
        applied = []
        c = _as(_undoable(applied), issue_grant(PRINCIPAL, AGENT.public, COMMIT_ONLY))
        p = _proposal_of(await c.intent("v.do", {}, auto=True))
        consent = _consent_of(await c.commit(p))
        assert applied == []
        assert (consent["proposal"], consent["hash"], consent["service"], consent["principal"]) == (
            p["id"], p["hash"], "v", PRINCIPAL.public)
        r = await c.commit(p, grants=[consent_grant(PRINCIPAL, AGENT.public, consent)])
        assert r.kind == "RECEIPT", r.lens
        assert applied == [PRINCIPAL.public]
        # A replay doesn't need the consent again: the commit already happened (§4.4).
        again = await c.commit(p)
        assert again.kind == "RECEIPT" and again.replay is True
        assert applied == [PRINCIPAL.public]

    run(go())


def test_an_untrusted_grant_for_the_intent_and_a_trusted_commit_only_grant_never_commit():
    stranger = key_from_seed(bytes([9]) * 32)

    async def go():
        applied = []
        c = _as(_undoable(applied), issue_grant(stranger, AGENT.public, []), issue_grant(PRINCIPAL, AGENT.public, COMMIT_ONLY))
        p = _proposal_of(await c.intent("v.do", {}, auto=True))
        assert _consent_of(await c.commit(p))["principal"] == PRINCIPAL.public
        assert applied == []

    run(go())


def test_with_require_grants_a_commit_only_grant_is_still_forbidden():
    async def go():
        applied = []
        c = _as(_undoable(applied, require_grants=True), issue_grant(PRINCIPAL, AGENT.public, COMMIT_ONLY))
        r = await c.intent("v.do", {}, auto=True)
        assert (r.kind, r.get("code")) == ("ERROR", "forbidden"), r.lens
        assert applied == []

    run(go())


def test_an_agent_cannot_consent_for_itself_by_delegating_only_to_its_own_key():
    async def go():
        applied = []
        svc = _undoable(applied)
        own = issue_grant(PRINCIPAL, AGENT.public, COMMIT_ONLY)
        p = _proposal_of(await _as(svc, own).intent("v.do", {}))
        self_consent = delegate_grant(own, AGENT, AGENT.public, [{"only": p["hash"]}])
        _consent_of(await _as(svc, self_consent).commit(p))
        assert applied == []

    run(go())


def test_only_a_grant_shaped_exactly_as_a_consent_commits_a_proposal_with_no_principal():
    async def go():
        applied = []
        c = _as(_undoable(applied), issue_grant(PRINCIPAL, AGENT.public, COMMIT_ONLY))
        p = _proposal_of(await c.intent("v.do", {}))
        svc, verbs, can, only, exp = (
            {"svc": ["v"]}, {"verbs": ["COMMIT"]}, {"can": ["v.do"]}, {"only": p["hash"]}, {"exp": p["expires"]})
        # Each is valid and allows this COMMIT, but isn't a consent to it.
        not_consents = {
            "a bare only": [only],
            "an extra caveat": [svc, verbs, can, only, exp, {"nbf": 0}],
            "a missing caveat": [svc, verbs, only, exp],
            "a wider can": [svc, verbs, {"can": ["v.*"]}, only, exp],
            "an earlier exp": [svc, verbs, can, only, {"exp": p["expires"] - 60}],
        }
        for name, caveats in not_consents.items():
            r = await c.commit(p, grants=[issue_grant(PRINCIPAL, AGENT.public, caveats)])
            assert _consent_of(r)["hash"] == p["hash"], name
        # Exactly a consent's caveats, but delegated on: a consent is a root grant.
        passed_on = delegate_grant(issue_grant(PRINCIPAL, OTHER_AGENT.public, [svc, verbs, can, only, exp]),
                                   OTHER_AGENT, AGENT.public, [])
        _consent_of(await c.commit(p, grants=[passed_on]))
        assert applied == []
        # The same caveats in another order are a consent.
        r = await c.commit(p, grants=[issue_grant(PRINCIPAL, AGENT.public, [exp, only, can, verbs, svc])])
        assert r.kind == "RECEIPT", r.lens
        assert applied == [PRINCIPAL.public]

    run(go())


def test_a_replay_with_grants_from_two_principals_is_matched_to_the_consents():
    async def go():
        applied = []
        c = _as(_undoable(applied), issue_grant(OTHER, AGENT.public, COMMIT_ONLY))
        p = _proposal_of(await c.intent("v.do", {}))
        consent = {**_consent_of(await c.commit(p)), "principal": PRINCIPAL.public}
        grants = [consent_grant(PRINCIPAL, AGENT.public, consent)]
        assert (await c.commit(p, grants=grants)).kind == "RECEIPT"
        again = await c.commit(p, grants=grants)
        assert again.kind == "RECEIPT" and again.replay is True, again.lens
        # Without the consent, the replay is the other principal's, who can't read the receipt.
        r = await c.commit(p)
        assert (r.kind, r.get("code")) == ("ERROR", "forbidden"), r.lens
        assert applied == [PRINCIPAL.public]

    run(go())


def test_an_intent_a_grant_authorized_still_auto_commits_under_its_principal():
    async def go():
        applied = []
        r = await _as(_undoable(applied), issue_grant(PRINCIPAL, AGENT.public, [])).intent("v.do", {}, auto=True)
        assert r.kind == "RECEIPT" and r.auto is True, r.lens
        assert applied == [PRINCIPAL.public]

    run(go())


# #83: only an integer from 1 to 2^52 is an undo window. A plan or proposal with any other window,
# zero and None included, can't be undone, so it never runs or commits on its own and reads
# ``never``. Mirrors ts/test/security.test.ts, "an undo window is a positive integer, or there is
# none".
NOT_WINDOWS = (0, -1, 1.5, "3600", float("nan"), 2**52 + 1, 2**53, True, None)
SERVER = key_from_seed(bytes([5]) * 32)


def _moving(undo_window, revert=True) -> JobCall:
    """A reschedule call that the signed policy allows, its one plan with this undo window."""
    async def plan():
        return [Plan("Move standup", [create("event/e1")], apply=lambda c: None, risk="low", undo_window=undo_window)]
    grant = issue_grant(PRINCIPAL, SERVER.public, [{"can": ["reschedule"]}]).encode()
    policy = load_policy(grant, SERVER.public, PRINCIPAL.public, Tightening())
    tool = JobTool("reschedule", revert=(lambda _: None) if revert else None)
    return JobCall(tool, {}, plan, "", NOW, policy, True)


def test_83_a_job_plan_with_any_other_window_is_not_undoable_so_the_policy_asks():
    async def go():
        assert (await job_call(_moving(60), MemoryStore())).kind == "run"
        for w in NOT_WINDOWS:
            o = await job_call(_moving(w), MemoryStore())
            assert o.kind == "ask", (w, o)
            assert "Approval needed: reschedule can't be undone." in o.form["message"], w
            assert "undo: never" in o.form["message"], w

    run(go())


def test_83_its_plan_hash_is_the_same_as_with_no_window_as_is_a_window_on_a_tool_without_revert():
    def hashed(revert=True, **window):
        [hp] = hash_plans(JobTool("reschedule", revert=(lambda _: None) if revert else None), {},
                          [Plan("Move standup", [create("event/e1")], apply=lambda c: None, risk="low", **window)])
        return hp

    none = hashed().plan_hash
    for w in NOT_WINDOWS:
        assert (hashed(undo_window=w).undoable, hashed(undo_window=w).plan_hash) == (False, none), w
    no_revert = hashed(revert=False, undo_window=60)
    assert (no_revert.undoable, no_revert.plan_hash) == (False, none)
    assert hashed(undo_window=60).plan_hash != none


async def _auto_move(**window):
    """An auto INTENT to a service whose one plan has ``revert`` and this undo window: the reply, and
    how many times the plan was applied."""
    applied = []
    svc = Service("cal", "Cal", "cal", trust=[PRINCIPAL.public])

    @svc.intent("cal.move", "move")
    def move(ctx):
        return Plan("move it", [create("event/1")], apply=lambda c: applied.append(1), revert=lambda c: None,
                    **window)

    return await client(svc).intent("cal.move", {}, auto=True), len(applied)


def test_83_a_service_sends_undo_null_for_any_other_window_and_never_auto_commits_it():
    async def go():
        for w in NOT_WINDOWS:
            r, applied = await _auto_move(undo_window=w)
            assert r.kind == "PROPOSALS" and r.proposals[0]["undo"] is None, (w, r.lens)
            assert applied == 0, w

    run(go())


def test_83_a_window_of_up_to_2_52_auto_commits_and_its_receipts_until_is_a_safe_integer():
    async def go():
        for window, seconds in (({}, 86400), ({"undo_window": 60}, 60), ({"undo_window": 2**52}, 2**52)):
            r, applied = await _auto_move(**window)
            assert r.kind == "RECEIPT", (window, r.lens)
            assert applied == 1, window
            until = r.receipt["undo"]["until"]
            assert until == r.receipt["at"] + seconds and until <= MAX_SAFE_INT, window

    run(go())


def test_83_a_client_renders_a_proposal_whose_window_is_any_other_value_as_undo_never():
    for w in NOT_WINDOWS:
        p = {"id": "p_1", "capability": "cal.move", "summary": "move it", "effects": [], "risk": "low",
             "undo": {"window": w}, "expires": NOW, "hash": "h"}
        assert "undo: never" in lens({"yea": 1, "id": "f", "re": "f", "kind": "PROPOSALS", "proposals": [p]}), w


# The commit ledger at its interface (#279), with no keys, proofs or sleeps: grant evaluation is a
# stand-in that judges one `total` (commit_ledger_fixture.py). More of it is in test_commit_ledger.py.
# Mirrors 'the commit ledger (#279)' in ts/test/security.test.ts.


def _no_events(_e):
    pass


def test_h2_concurrent_commits_cant_overshoot_a_spend_cap():
    """[H2] Grant evaluation is synchronous here, so the second commit's sees the first's reservation
    and needs consent. Had it missed it, the reservation refuses, naming the measure (#145)."""

    async def go():
        f, grant = LedgerFixture(), TotalGrant(100)
        a, b = f.propose(60), f.propose(60)
        ra, rb = await asyncio.gather(
            f.ledger.commit(commit_of(a, grant.admit), _no_events), f.ledger.commit(commit_of(b, grant.admit), _no_events),
            return_exceptions=True)
        assert ra["kind"] == "RECEIPT" and grant.calls == 2
        assert isinstance(rb, YeaError) and rb.code == "consent_required"

        def blind(proposal, used):
            return Admitted("alice", [TotalLimit(LedgerKey("b_1", "spend"), grant.max)])

        with pytest.raises(YeaError) as e:
            await f.ledger.commit(commit_of(b, blind), _no_events)
        assert (e.value.code, e.value.message.split(";")[0]) == (
            "consent_required", "spend would pass a total limit (other commits are in flight)")
        assert (e.value.consent["proposal"], e.value.consent["principal"]) == (b.proposal["id"], "alice")

    run(go())


def test_u5_two_concurrent_commits_of_one_proposal_run_it_once_and_count_it_once():
    """[U5] apply runs once, one reply is a replay, and only 60 of 100 is used."""

    async def go():
        f, grant, runs = LedgerFixture(), TotalGrant(100), []
        started, held = asyncio.Event(), asyncio.Event()

        async def apply(c):
            runs.append(1)
            started.set()
            await held.wait()

        p = f.propose(60, apply=apply)
        both = asyncio.gather(
            f.ledger.commit(commit_of(p, grant.admit), _no_events), f.ledger.commit(commit_of(p, grant.admit), _no_events))
        await started.wait()
        held.set()
        r1, r2 = await both
        assert runs == [1] and [r1["kind"], r2["kind"]] == ["RECEIPT", "RECEIPT"]
        assert [bool(r.get("replay")) for r in (r1, r2)].count(True) == 1
        assert await code_of(f.ledger.commit(commit_of(f.propose(40), grant.admit), _no_events)) == "ok"  # 40 still fits

    run(go())


def test_u5b_a_sync_apply_that_raises_once_is_retried_and_a_success_still_runs_once(caplog):
    """[U5b] #187: a synchronous raise from apply() must not leave its ERROR kept as the outcome."""

    async def go():
        f, grant, runs = LedgerFixture(), TotalGrant(100), []

        def apply(c):
            runs.append(1)
            if len(runs) == 1:
                raise RuntimeError("card network down")
            return {"ok": True}

        p = f.propose(60, apply=apply)

        def commit():
            return f.ledger.commit(commit_of(p, grant.admit), _no_events)

        assert (await commit())["code"] == "internal" and "card network down" in caplog.text
        retried = await commit()
        assert retried["kind"] == "RECEIPT" and "replay" not in retried and len(runs) == 2
        assert (await commit())["replay"] is True and len(runs) == 2
        # The failed attempt released its spend exactly once: 60 of the 100 is used, so 41 is over
        # and 40 fits.
        assert await code_of(f.ledger.commit(commit_of(f.propose(41), grant.admit), _no_events)) == "consent_required"
        assert await code_of(f.ledger.commit(commit_of(f.propose(40), grant.admit), _no_events)) == "ok"

    run(go())


def test_a_request_cancelled_mid_run_still_runs_once_and_its_retry_gets_a_replay():
    """Python only (#291): a transport may cancel a request's task when its client goes away. The auto
    INTENT, COMMIT or UNDO it started still runs once, and a retry of the same frame gets the replay
    from Service.handle, never a CancelledError."""
    gate, ran = SimpleNamespace(started=asyncio.Event(), held=asyncio.Event()), []
    svc = Service("v", "V", "v", trust=[PRINCIPAL.public])
    grants = [issue_grant(PRINCIPAL, AGENT.public, []).encode()]

    async def held(step):
        ran.append(step)
        gate.started.set()
        await gate.held.wait()

    @svc.intent("v.do", "do")
    def do(ctx):
        return Plan("do it", [create("thing/1")], apply=lambda c: held("apply"), revert=lambda c: held("revert"))

    def framed(verb, target, **fields):
        proof = sign_proof(AGENT, "v", verb, target, int(time.time()))
        return {"yea": 1, "verb": verb, "grants": grants, "proof": proof, **fields}

    async def cancelled_then_retried(frame):
        gate.started.clear()
        gate.held.clear()
        task = asyncio.ensure_future(svc.handle(frame))
        await gate.started.wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        gate.held.set()
        return await svc.handle(frame)

    async def go():
        auto = await cancelled_then_retried(framed("INTENT", "auto:v.do:i1", id="i1", capability="v.do", auto=True))
        assert (auto["kind"], auto["auto"], auto["replay"]) == ("RECEIPT", True, True)
        p = (await svc.handle(framed("INTENT", "v.do", id="i2", capability="v.do")))["proposals"][0]
        commit = await cancelled_then_retried(framed("COMMIT", p["hash"], id="c1", proposal=p["id"], hash=p["hash"]))
        assert (commit["kind"], commit["replay"]) == ("RECEIPT", True)
        rid = commit["receipt"]["id"]
        undo = await cancelled_then_retried(framed("UNDO", rid, id="u1", receipt=rid))
        assert (undo["kind"], undo["replay"], undo["receipt"]["undoes"]) == ("RECEIPT", True, rid)
        assert ran == ["apply", "apply", "revert"]

    run(go())


def test_a_run_cut_off_by_its_loops_teardown_is_in_doubt_never_run_again_and_its_spend_kept():
    """Python only (#291): a host that runs each request in its own asyncio.run tears the loop down
    with a run pending, after its apply sent a payment. Treated as never having happened, a retry paid
    again, past the total, and an agent's fresh auto INTENT auto-paid again. The run is in doubt: a
    retry gets ``internal``, the spend still counts, and a fresh auto INTENT only proposes."""
    sent, hanging = [], []
    svc = Service("pay", "Pay", "pay", trust=[PRINCIPAL.public])

    @svc.intent("pay.send", "send money", {"amt": "int"})
    def send(ctx):
        async def apply(c):
            sent.append(ctx.params["amt"])  # the payment is out
            if hanging:
                await asyncio.Event().wait()  # and the bank's answer never comes

        uses = {"spend": quantity(ctx.params["amt"], scale=2, unit="USD")}
        return Plan("pay", [create("payment/1")], apply=apply, revert=lambda c: None, uses=uses)

    grants = [issue_grant(PRINCIPAL, AGENT.public, [{"total": {"of": "spend", "max": 100, "scale": 2, "unit": "USD"}}]).encode()]

    def framed(verb, target, **fields):
        return {"yea": 1, "verb": verb, "grants": grants, "proof": sign_proof(AGENT, "pay", verb, target, int(time.time())),
                **fields}

    def auto(fid, amt):
        return framed("INTENT", f"auto:pay.send:{fid}", id=fid, capability="pay.send", params={"amt": amt}, auto=True)

    def commit(p, fid):
        return framed("COMMIT", p["hash"], id=fid, proposal=p["id"], hash=p["hash"])

    async def paying(frame):
        paid = len(sent)
        asyncio.ensure_future(svc.handle(frame))
        while len(sent) == paid:
            await asyncio.sleep(0)

    def cut_off(frame):
        """The host gives up on the request once its payment is out; asyncio.run then tears down."""
        hanging.append(1)
        run(paying(frame))
        hanging.clear()

    def in_doubt(reply):
        return (reply["kind"], reply["code"]) == ("ERROR", "internal") and "unknown" in reply["message"]

    cut_off(auto("i1", 60))
    assert in_doubt(run(svc.handle(auto("i1", 60))))
    fresh = run(svc.handle(auto("i2", 40)))
    assert fresh["kind"] == "PROPOSALS" and sent == [60]  # it proposes; it doesn't pay again
    cut_off(commit(fresh["proposals"][0], "c1"))
    assert in_doubt(run(svc.handle(commit(fresh["proposals"][0], "c1"))))
    assert sent == [60, 40]
    # Both count: 100 of the 100 is used.
    one = run(svc.handle(framed("INTENT", "pay.send", id="i3", capability="pay.send", params={"amt": 1})))["proposals"][0]
    assert run(svc.handle(commit(one, "c2")))["code"] == "consent_required"


def test_an_emit_that_raises_never_fails_a_commit_or_undo_so_neither_runs_twice():
    """Python twin of TS #166/#167 (``neverThrows``): a host whose emit raises once its client hung
    up turned a plan's ``progress`` after the payment into a failed ``apply``. The commit was freed,
    so a retry paid again, past the total. ``Service.handle`` now drops and logs that EVENT."""
    sent, refunded = [], []
    svc = Service("pay", "Pay", "pay", trust=[PRINCIPAL.public])

    @svc.intent("pay.send", "send money", {"amt": "int"})
    def send(ctx):
        def apply(c):
            sent.append(ctx.params["amt"])
            c.progress("payment sent", 1.0)

        def revert(c):
            refunded.append(ctx.params["amt"])
            c.progress("payment refunded", 1.0)

        uses = {"spend": quantity(ctx.params["amt"], scale=2, unit="USD")}
        return Plan("pay", [create("payment/1")], apply=apply, revert=revert, uses=uses)

    grants = [issue_grant(PRINCIPAL, AGENT.public, [{"total": {"of": "spend", "max": 100, "scale": 2, "unit": "USD"}}]).encode()]

    def framed(verb, target, **fields):
        return {"yea": 1, "verb": verb, "grants": grants, "proof": sign_proof(AGENT, "pay", verb, target, int(time.time())),
                **fields}

    def hung_up(_event):
        raise ConnectionResetError("the client hung up")

    p = run(svc.handle(framed("INTENT", "pay.send", id="i1", capability="pay.send", params={"amt": 60})))["proposals"][0]
    commit = framed("COMMIT", p["hash"], id="c1", proposal=p["id"], hash=p["hash"])
    first = run(svc.handle(commit, hung_up))
    assert first["kind"] == "RECEIPT"
    assert run(svc.handle(commit))["replay"] is True and sent == [60]
    rid = first["receipt"]["id"]
    undo = framed("UNDO", rid, id="u1", receipt=rid)
    assert run(svc.handle(undo, hung_up))["receipt"]["undoes"] == rid
    assert run(svc.handle(undo))["replay"] is True and refunded == [60]



# #405: a ``total`` with ``every`` counts in fixed periods from its block's one ``nbf`` (SPEC §6.3).
# A wrong key lets a cap go unenforced, so each way the key could slip is pinned here. Mirrors
# "a total that counts in periods (#405)" in ts/test/security.test.ts.

DAY = 86_400
WEEK = 7 * DAY
T0 = 1_790_000_000  # the commit ledger fixture's clock starts here
SUB = key_from_seed(bytes([3]) * 32)


def _usd(cents, every=None):
    return {"of": "spend", "max": cents, "scale": 2, "unit": "USD", **({} if every is None else {"every": every})}


def _policy(*caveats):
    return issue_grant(PRINCIPAL, AGENT.public, list(caveats), iat=T0)


def _check(grant, now=T0, verb="COMMIT", holder=AGENT.public, used=None, limits=True):
    proposal = {"hash": "h", "risk": "low", "uses": {"spend": quantity(100, scale=2, unit="USD")}}
    ctx = GrantContext("pay", verb, "pay.send", now, proposal, used or {}, limits)
    return verify_grant(grant, [PRINCIPAL.public], holder, ctx)


def _code(v):
    return "ok" if v.ok else v.code


def _admit(grant, at):
    return grant_admit(grant, AGENT.public, PRINCIPAL.public, at)


def test_405_a_malformed_every_or_every_on_each_fails_closed_on_every_verb():
    bad = [{"total": {**_usd(100), "every": every}} for every in (0, -1, "7d", True, None, [], {})]
    bad.append({"each": _usd(100, WEEK)})
    for c in bad:
        g = _policy(c, {"nbf": T0 - DAY}, {"exp": T0 + WEEK})
        for verb in ("ASK", "COMMIT"):
            assert _code(_check(g, verb=verb)) == "forbidden", (verb, c)


def test_405_an_every_with_no_canonical_form_makes_the_grant_unauthorized():
    g = _policy({"total": _usd(100, WEEK)}, {"nbf": T0 - DAY}, {"exp": T0 + WEEK}).encode()
    text = base64.urlsafe_b64decode(g[4:] + "=" * (-len(g[4:]) % 4)).decode()
    for to in ("1.5", "9007199254740992", "6.048e5", "604800.0"):
        respelled = text.replace(f'"every":{WEEK}', f'"every":{to}')
        assert f'"every":{to}' in respelled
        v = _check("pg1." + b64url_encode(respelled.encode()), verb="ASK")
        assert (v.code, v.reason.split(":")[0]) == ("unauthorized", "malformed grant"), to


def test_405_a_block_with_a_periodic_total_needs_exactly_one_nbf_of_its_own_on_every_verb():
    total, exp = {"total": _usd(100, WEEK)}, {"exp": T0 + WEEK}
    none = _policy(total, exp)
    two = _policy(total, {"nbf": T0 - DAY}, {"nbf": T0 - 2 * DAY}, exp)
    # A holder can append an nbf, but it isn't the root block's own: the root's total still fails.
    appended = delegate_grant(none, AGENT, SUB.public, [{"nbf": T0 - DAY}])
    for verb in ("ASK", "COMMIT"):
        assert _code(_check(none, verb=verb)) == "forbidden"
        assert _code(_check(two, verb=verb)) == "forbidden"
        assert _code(_check(appended, verb=verb, holder=SUB.public)) == "forbidden"
    # Two nbf caveats in a block without a periodic total are as valid as they were.
    assert _code(_check(_policy({"nbf": T0 - DAY}, {"nbf": T0 - 2 * DAY}), verb="ASK")) == "ok"


def test_405_a_periodic_totals_exp_is_in_its_block_or_an_earlier_one_a_holder_cant_add_its_own_end():
    no_end = "a total with every needs an exp in its block or an earlier one"
    endless = _policy({"total": _usd(100, WEEK)}, {"nbf": T0 - DAY})
    # The holder appends the latest exp there is, for a sub-agent or for itself.
    for_sub = delegate_grant(endless, AGENT, SUB.public, [{"exp": 2**53 - 1}])
    for_self = delegate_grant(endless, AGENT, AGENT.public, [{"exp": 2**53 - 1}])
    # A delegation's own periodic total is ended by the root's exp, an earlier block's.
    rooted = delegate_grant(
        _policy({"nbf": T0 - DAY}, {"exp": T0 + WEEK}), AGENT, SUB.public,
        [{"total": _usd(100, DAY)}, {"nbf": T0 - DAY}],
    )
    for verb in ("ASK", "COMMIT"):
        assert _code(_check(endless, verb=verb)) == "forbidden"
        for grant, holder in ((for_sub, SUB.public), (for_self, AGENT.public)):
            r = _check(grant, verb=verb, holder=holder)
            assert (r.code, r.reason) == ("forbidden", no_end), verb
        assert _code(_check(rooted, verb=verb, holder=SUB.public)) == "ok"


def test_405_the_anchor_and_end_rules_hold_where_only_who_may_act_is_checked_limits_off_on_every_verb():
    unanchored = _policy({"total": _usd(100, WEEK)}, {"exp": T0 + WEEK})
    unended = _policy({"total": _usd(100, WEEK)}, {"nbf": T0 - DAY})
    for grant, reason in (
        (unanchored, "a total with every needs exactly one nbf in its block"),
        (unended, "a total with every needs an exp in its block or an earlier one"),
    ):
        for verb in ("ASK", "COMMIT"):
            # A service checks ASK, INTENT and UNDO this way: the limits never deny, the rules still do.
            r = _check(grant, verb=verb, limits=False)
            assert (r.code, r.reason) == ("forbidden", reason), verb


def test_405_a_clock_that_isnt_a_whole_second_is_refused_with_or_without_a_period():
    exp = {"exp": T0 + WEEK}
    lifetime = _policy({"total": _usd(100)}, exp)
    weekly = _policy({"total": _usd(100, WEEK)}, {"nbf": T0 - DAY}, exp)
    for grant in (lifetime, weekly):
        r = _check(grant, now=T0 + 0.5)
        assert (r.code, r.reason) == ("forbidden", f"the time to check at is not a whole second: {T0 + 0.5}")
        assert _code(_check(grant)) == "ok"


def test_405_a_delegation_blocks_nbf_never_moves_the_roots_periods():
    nbf = T0 - 8 * DAY  # T0 is in the root's second week, which starts at nbf + WEEK
    root = _policy({"total": _usd(50000, WEEK)}, {"nbf": nbf}, {"exp": nbf + 10 * WEEK})
    week1 = LedgerKey(root.id, "spend", Period(WEEK, nbf + WEEK))
    # An nbf two days in moves nothing: anchored there, T0 would be in a fresh first week.
    later = delegate_grant(root, AGENT, SUB.public, [{"nbf": nbf + 2 * DAY}])
    full = {week1: 50000 * 10**16}
    assert _code(_check(later, holder=SUB.public, used=full)) == "consent_required"
    # A delegation's own periodic total counts under its own id, from its own nbf.
    own = delegate_grant(root, AGENT, SUB.public, [{"total": _usd(10000, DAY)}, {"nbf": nbf + 2 * DAY + 3600}])
    v = _check(own, holder=SUB.public)
    assert [t.key for t in v.totals] == [week1, LedgerKey(own.block_ids[1], "spend", Period(DAY, nbf + 7 * DAY + 3600))]


def test_405_100_a_day_and_500_a_week_in_one_block_the_sixth_day_asks_and_the_next_week_runs():
    f = LedgerFixture()
    g = _policy({"total": _usd(10000, DAY)}, {"total": _usd(50000, WEEK)}, {"nbf": T0}, {"exp": T0 + 4 * WEEK})
    admit = _admit(g, lambda: f.t)

    def commit(cents):
        return run(code_of(f.ledger.commit(commit_of(f.propose(cents), admit), _no_events)))

    for day in range(5):
        assert commit(10000) == "ok", day
        assert commit(1) == "consent_required", day
        f.advance(DAY)
    # Each day has room, but the week has had its 500.
    with pytest.raises(YeaError, match="the total limit of 500.00 USD every 7d"):
        run(f.ledger.commit(commit_of(f.propose(10000), admit), _no_events))
    f.advance(2 * DAY)
    assert commit(10000) == "ok"


def test_405_500_a_week_and_1000_in_all_the_third_week_asks():
    f = LedgerFixture()
    g = _policy({"total": _usd(50000, WEEK)}, {"total": _usd(100000)}, {"nbf": T0}, {"exp": T0 + 10 * WEEK})
    admit = _admit(g, lambda: f.t)

    def commit():
        return f.ledger.commit(commit_of(f.propose(50000), admit), _no_events)

    assert run(commit())["kind"] == "RECEIPT"
    f.advance(WEEK)
    assert run(commit())["kind"] == "RECEIPT"
    f.advance(WEEK)
    with pytest.raises(YeaError) as e:
        run(commit())
    assert e.value.message == "spend would pass the total limit of 1000.00 USD"


def test_405_a_service_whose_clock_reads_fractional_seconds_floors_it_and_a_periodic_grant_still_commits():
    at = time.time() // 1 + 0.75
    c = client(pay_service(now=lambda: at), {"total": _usd(50000, WEEK)}, {"nbf": int(at) - DAY}, {"exp": int(at) + WEEK})

    async def go():
        r = await c.commit(await proposal(c, "ana", 100))
        assert r.kind == "RECEIPT", r.lens

    asyncio.run(go())


def test_405_the_clock_crossing_a_boundary_between_admit_and_reserve_lands_in_the_period_checked():
    f = LedgerFixture()
    g = _policy({"total": _usd(50000, WEEK)}, {"nbf": T0 + 1 - WEEK}, {"exp": T0 + 4 * WEEK})  # a week ending at T0 + 1
    admit = _admit(g, lambda: f.t)

    def crossing(proposal, used):
        admitted = admit(proposal, used)
        f.advance(2)
        return admitted

    assert run(f.ledger.commit(commit_of(f.propose(50000), crossing), _no_events))["kind"] == "RECEIPT"
    # The new week is empty, and the old one, checked at T0, is full.
    assert run(f.ledger.commit(commit_of(f.propose(50000), admit), _no_events))["kind"] == "RECEIPT"
    last_week = _admit(g, lambda: T0)
    assert run(code_of(f.ledger.commit(commit_of(f.propose(1), last_week), _no_events))) == "consent_required"


def test_405_a_reservation_released_after_the_boundary_frees_its_own_period_only(caplog):
    f = LedgerFixture()
    g = _policy({"total": _usd(50000, WEEK)}, {"nbf": T0 + 1 - WEEK}, {"exp": T0 + 4 * WEEK})

    def apply(_ctx):
        f.advance(2)
        raise RuntimeError("card network down")

    failed = run(f.ledger.commit(commit_of(f.propose(50000, apply=apply), _admit(g, lambda: f.t)), _no_events))
    assert failed["kind"] == "ERROR" and failed["code"] == "internal"
    # Released from the week it was taken in: that week has its 500 back, and the new one too.
    last_week = _admit(g, lambda: T0)
    assert run(f.ledger.commit(commit_of(f.propose(50000), last_week), _no_events))["kind"] == "RECEIPT"
    assert run(f.ledger.commit(commit_of(f.propose(50000), _admit(g, lambda: f.t)), _no_events))["kind"] == "RECEIPT"
