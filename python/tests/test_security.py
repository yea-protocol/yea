"""The SDK's security regression list, ported from ts/test/security.test.ts (#153). Each test
names the TS id it mirrors."""

import asyncio
import json
import socket
import time
import urllib.error
import urllib.request

import pytest

from yea import (
    Client, GrantContext, Plan, Service, create, decode_grant, issue_grant, key_from_seed, local, serve_http, verify_grant,
)
from yea._json import b64url_encode
from yea.approval import reserve_all
from yea.store import LedgerKey, MemoryStore
from yea.uses import quantity

PRINCIPAL = key_from_seed(bytes([1]) * 32)
AGENT = key_from_seed(bytes([2]) * 32)


def run(coro):
    return asyncio.run(coro)


def pay_service(runs=None, slow=0.0):
    """A payment service: ``pay.send`` spends ``amt`` hundredths of a dollar."""
    svc = Service("pay", "Pay", "pay", trust=[PRINCIPAL.public])

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


def test_u5_two_concurrent_commits_of_one_proposal_run_it_once_and_count_it_once():
    """[U5] apply runs once, one reply is a replay, and only 60 of 100 is used."""
    runs = []

    async def go():
        c = client(pay_service(runs, slow=0.02), {"total": {"of": "spend", "max": 100, "scale": 2, "unit": "USD"}})
        p = await proposal(c, "a", 60)
        r1, r2 = await asyncio.gather(c.commit(p), c.commit(p))
        assert runs == [1] and [r1.kind, r2.kind] == ["RECEIPT", "RECEIPT"]
        assert [bool(r.get("replay")) for r in (r1, r2)].count(True) == 1
        assert (await c.commit(await proposal(c, "b", 40))).kind == "RECEIPT"  # 40 still fits

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


def test_a_commit_replay_whose_receipt_is_gone_is_refused_not_crashed():
    """The replay path looks the receipt up with .get(): a missing one is forbidden, not a KeyError."""
    async def go():
        svc = pay_service()
        c = client(svc)
        p = await proposal(c, "a", 1)
        first = await c.commit(p)
        assert first.kind == "RECEIPT"
        svc._receipts.clear()
        return await c.commit(p)

    r = run(go())
    assert r.kind == "ERROR" and r.code == "forbidden"


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
