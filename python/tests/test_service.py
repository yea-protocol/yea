import asyncio
import json
import sys
import time
import urllib.error
import urllib.request

import pytest
from calendar_example import calendar
from conftest import ROOT

from yea import (
    Client,
    YeaError,
    Plan,
    Service,
    clarify,
    connect,
    consent_grant,
    create,
    est,
    issue_grant,
    key_from_seed,
    local,
    quantity,
    serve_http,
    serve_tcp,
    sign_proof,
    spend,
)
from yea.uses import value

PRINCIPAL = key_from_seed(bytes([1]) * 32)
AGENT = key_from_seed(bytes([2]) * 32)
OTHER = key_from_seed(bytes([3]) * 32)


def run(coro):
    return asyncio.run(coro)


def grant(*caveats, sub=AGENT, iss=PRINCIPAL):
    return issue_grant(iss, sub.public, list(caveats))


def shop():
    svc = Service("shop.example", "Shop", "Buy things.", trust=[PRINCIPAL.public])
    orders = []

    @svc.intent("shop.order", "Order an item", {"sku": "string", "qty": "int"}, risk="medium")
    def order(ctx):
        qty = ctx.params["qty"]
        if qty > 100:
            raise YeaError("limit", "at most 100 per order", fix=[{"say": "order 100", "params": {"qty": 100}}])

        def apply(c):
            c.progress("charging card", 0.5)
            orders.append(qty)
            return {"order": len(orders)}

        return Plan(f"Order {qty}× {ctx.params['sku']}", [create("card/default", f"{qty} items")], apply,
                    uses={"spend": quantity(1500 * qty, scale=2, unit="USD")}, revert=lambda c: orders.pop(), undo_window=600)

    @svc.intent("shop.pick", "Ambiguous", {})
    def pick(ctx):
        return clarify("Which?", [{"label": "A", "params": {"x": 1}}])

    @svc.ask("shop.catalog", "Everything", {})
    def catalog(ctx):
        return {"items": [{"sku": f"m{i:03d}", "name": "widget " * 5, "price": 1500} for i in range(300)], "note": "x" * 5000}

    svc.orders = orders
    return svc


# ------------------------------------------------------------ service semantics


def test_bad_frames():
    svc = shop()
    for frame, code in [
        (None, "bad_frame"), ({"id": "1", "verb": "HELLO"}, "bad_frame"), ({"yea": 1, "id": "1", "verb": "GET"}, "bad_frame"),
        ({"yea": 1, "id": "1", "verb": "ASK", "capability": "shop.catalgo"}, "unknown_capability"),
        ({"yea": 1, "id": "1", "verb": "INTENT", "capability": "shop.order", "params": {"sku": 1}}, "invalid_params"),
        ({"yea": 1, "id": "1", "verb": "COMMIT", "proposal": "p_x", "hash": "h"}, "not_found"),
        ({"yea": 1, "id": "1", "verb": "EXPAND", "handle": "h_x"}, "expired"),
    ]:
        r = run(svc.handle(frame))
        assert r["kind"] == "ERROR" and r["code"] == code, r
    r = run(svc.handle({"yea": 1, "id": "1", "verb": "ASK", "capability": "shop.catalgo"}))
    assert r["fix"] == [{"say": "did you mean shop.catalog?"}]


def test_intent_validation_paths():
    svc = Service("s", "S", trust=[PRINCIPAL.public])
    svc.intent("x.order", "o", {"items?": [{"sku": "string", "qty": "int"}]})(lambda ctx: [])
    r = run(svc.handle({"yea": 1, "id": "1", "verb": "INTENT", "capability": "x.order", "params": {"items": [{"sku": "a", "qty": "2"}]}}))
    assert r["code"] == "invalid_params" and "`items.0.qty` must be an integer" in r["message"]


def test_commit_flow_replay_undo_and_events():
    async def go():
        svc = shop()
        c = Client(local(svc), key=AGENT, grants=[grant({"can": ["shop.*"]})])
        props = await c.intent("shop.order", {"sku": "m002", "qty": 2})
        assert props.kind == "PROPOSALS"
        p = props.proposals[0]
        assert p["undo"] == {"window": 600} and p["uses"] == {"spend": {"amount": 3000, "scale": 2, "unit": "USD"}}
        events = []
        rc = await c.commit(p, on_event=events.append)
        assert rc.kind == "RECEIPT" and svc.orders == [2]
        assert [e.lens for e in events] == ["… charging card (50%)"]
        again = await c.commit(p)
        assert again.replay is True and again.receipt == rc.receipt and svc.orders == [2]
        assert "(replay)" in again.lens.splitlines()[0]
        un = await c.undo(rc.receipt["id"])
        assert un.receipt["undoes"] == rc.receipt["id"] and svc.orders == []
        assert un.receipt["effects"] == [{"op": "delete", "target": "card/default", "detail": "2 items"}]
        assert "uses" in rc.receipt and "uses" not in un.receipt
        assert (await c.undo(rc.receipt["id"])).replay is True and svc.orders == []
        assert (await c.undo(un.receipt["id"])).code == "not_found"

    run(go())


def test_commit_needs_grant_and_matching_hash():
    async def go():
        svc = shop()
        c = Client(local(svc), key=AGENT, grants=[grant()])
        p = (await c.intent("shop.order", {"sku": "a", "qty": 1})).proposals[0]
        assert (await Client(local(svc)).commit(p)).code == "unauthorized"
        bad = await c.commit({**p, "hash": "nope"})
        assert bad.code == "conflict" and p["hash"] not in json.dumps(bad.frame)  # never reveal the hash
        thief = Client(local(svc), key=OTHER, grants=[grant()])  # someone else's grant, own key
        assert (await thief.commit(p)).code == "unauthorized"
        assert (await c.commit(p)).kind == "RECEIPT"

    run(go())


def test_only_the_requester_can_commit():
    """§4.4: a party can't prepare a proposal for someone else's agent to commit."""

    async def go():
        svc = shop()
        other_principal = key_from_seed(bytes([9]) * 32)
        svc.trust.append(other_principal.public)
        anon_p = (await Client(local(svc)).intent("shop.order", {"sku": "a", "qty": 1})).proposals[0]
        agent = Client(local(svc), key=AGENT, grants=[grant()])
        r = await agent.commit(anon_p)
        assert r.code == "forbidden" and "anonymous" in r.message
        # OTHER asks, with its own valid grant; AGENT (also validly granted) can't commit it.
        other = Client(local(svc), key=OTHER, grants=[grant(sub=OTHER)])
        other_p = (await other.intent("shop.order", {"sku": "a", "qty": 1})).proposals[0]
        assert (await agent.commit(other_p)).code == "forbidden"
        # Same agent key, but a grant from a different principal than the INTENT's: skipped.
        mine = (await agent.intent("shop.order", {"sku": "a", "qty": 1})).proposals[0]
        switch = Client(local(svc), key=AGENT, grants=[grant(iss=other_principal)])
        assert (await switch.commit(mine)).code == "forbidden"
        assert svc.orders == []
        assert (await agent.commit(mine)).kind == "RECEIPT" and (await other.commit(other_p)).kind == "RECEIPT"

    run(go())


def test_forbidden_carries_need():
    async def go():
        svc = shop()
        c = Client(local(svc), key=AGENT, grants=[grant({"can": ["calendar.*"]})])
        p = (await c.intent("shop.order", {"sku": "a", "qty": 1})).proposals[0]
        r = await c.commit(p)
        assert r.code == "forbidden" and r.need == [{"can": ["calendar.*"]}] and r.message == "does not cover shop.order"
        assert '  need: [{"can":["calendar.*"]}]' in r.lens

    run(go())


def test_consent_flow_and_spend_accounting():
    async def go():
        svc = shop()
        g = grant({"each": {"of": "spend", "max": 5000, "scale": 2, "unit": "USD"}}, {"total": {"of": "spend", "max": 6000, "scale": 2, "unit": "USD"}})
        c = Client(local(svc), key=AGENT, grants=[g])
        big = (await c.intent("shop.order", {"sku": "m002", "qty": 4})).proposals[0]  # 6000 > per 5000
        r = await c.commit(big)
        assert r.code == "consent_required"
        assert r.message == "spend over the per-commit limit of 50.00 USD; your principal must approve this exact proposal"
        assert r.consent["hash"] == big["hash"] and r.consent["principal"] == PRINCIPAL.public
        assert f"  consent: principal must approve {big['hash']}" in r.lens
        ok = await c.commit(big, grants=[consent_grant(PRINCIPAL, AGENT.public, r.consent)])
        assert ok.kind == "RECEIPT"
        # The consent grant authorized that commit, so the spend cap block was not charged:
        small = (await c.intent("shop.order", {"sku": "m002", "qty": 3})).proposals[0]  # 4500
        assert (await c.commit(small)).kind == "RECEIPT"
        # ...but now 4500 of 6000 is spent through g, so another 3000 needs consent.
        more = (await c.intent("shop.order", {"sku": "m002", "qty": 2})).proposals[0]
        assert (await c.commit(more)).code == "consent_required"
        # A consent grant for one proposal doesn't cover another.
        wrong = consent_grant(PRINCIPAL, AGENT.public, r.consent)
        assert (await c.commit(more, grants=[wrong])).code == "consent_required"

    run(go())


def test_consent_grant_cannot_undo_or_reach_other_proposals():
    """Regression: a consent grant used to authorize any UNDO/ASK/INTENT until it expired."""

    async def go():
        svc = shop()
        normal = Client(local(svc), key=AGENT, grants=[grant({"each": {"of": "spend", "max": 5000, "scale": 2, "unit": "USD"}})])
        a = await normal.commit((await normal.intent("shop.order", {"sku": "a", "qty": 1})).proposals[0])
        b = (await normal.intent("shop.order", {"sku": "b", "qty": 4})).proposals[0]
        need = await normal.commit(b)
        assert need.consent["service"] == "shop.example" and need.consent["capability"] == "shop.order"
        only_consent = Client(local(svc), key=AGENT, grants=[consent_grant(PRINCIPAL, AGENT.public, need.consent)])
        assert (await only_consent.undo(a.receipt["id"])).code == "forbidden"
        assert svc.orders == [1]
        assert (await only_consent.commit(b)).kind == "RECEIPT"

    run(go())


def test_undo_requires_same_principal():
    async def go():
        svc = shop()
        other_principal = key_from_seed(bytes([9]) * 32)
        svc.trust.append(other_principal.public)
        c = Client(local(svc), key=AGENT, grants=[grant()])
        rc = await c.commit((await c.intent("shop.order", {"sku": "a", "qty": 1})).proposals[0])
        c2 = Client(local(svc), key=AGENT, grants=[grant(iss=other_principal)])
        assert (await c2.undo(rc.receipt["id"])).code == "forbidden"

    run(go())


def test_expired_proposal_and_proof_window():
    async def go():
        clock = [1_790_000_000]
        svc = Service("s", "S", trust=[PRINCIPAL.public], now=lambda: clock[0])
        svc.intent("x.do", "d")(lambda ctx: Plan("do", [], lambda c: None, expires_in=60))
        p = (await Client(local(svc)).intent("x.do")).proposals[0]
        assert p["expires"] == -(-(clock[0] + 60) // 60) * 60 == 1_790_000_100  # rounded up to the minute
        c = Client(local(svc), key=AGENT, grants=[grant()])
        r = await c.commit(p)  # proof ts is real time, far from the fake clock
        assert r.code == "unauthorized" and "300s" in r.message
        # Even where grants are optional, a presented grant with a bad proof is rejected (as in TS).
        assert (await c.intent("x.do")).code == "unauthorized"

    run(go())


def test_clarify_and_ask_grants_optional():
    async def go():
        svc = shop()
        c = Client(local(svc), key=AGENT, grants=[grant({"verbs": ["COMMIT"]})])
        r = await c.intent("shop.pick")
        assert r.kind == "CLARIFY" and r.lens == "? Which?\n  1. A"

    run(go())


def test_require_grants():
    svc = Service("s", "S", trust=[PRINCIPAL.public], require_grants=True)
    svc.ask("x.read", "r")(lambda ctx: ctx.principal)

    async def go():
        assert (await Client(local(svc)).ask("x.read")).code == "unauthorized"
        assert (await Client(local(svc), key=AGENT, grants=[grant()]).ask("x.read")).data == PRINCIPAL.public
        assert (await Client(local(svc), key=AGENT, grants=[grant({"verbs": ["COMMIT"]})]).ask("x.read")).code == "forbidden"

    run(go())


def test_client_skips_grants_for_other_services():
    async def go():
        svc = shop()
        c = Client(local(svc), key=AGENT, grants=[grant({"svc": ["calendar.example"]})])
        p = (await c.intent("shop.order", {"sku": "a", "qty": 1})).proposals[0]
        r = await c.commit(p)
        assert r.code == "unauthorized" and "needs a grant" in r.message

    run(go())


def test_budget_and_expand():
    async def go():
        svc = shop()
        c = Client(local(svc))
        r = await c.ask("shop.catalog", budget=300)
        assert est(r.lens) <= 300
        paths = {m["path"]: m for m in r.more}
        assert set(paths) == {"data.items", "data.note"}
        assert r.data["note"].endswith("…") and len(r.data["note"]) < 5000
        items = list(r.data["items"])
        handle = paths["data.items"]["handle"]
        while handle:
            x = await c.expand(handle, budget=2000)
            assert x.kind == "ANSWER"
            items += x.data["items"]
            handle = next((m["handle"] for m in x.get("more", []) if m["path"] == "data.items"), None)
        assert [i["sku"] for i in items] == [f"m{i:03d}" for i in range(300)]
        t = await c.expand(paths["data.note"]["handle"], budget=5000)
        assert r.data["note"][:-1] + t.data["text"] == "x" * 5000

    run(go())


def test_proposals_are_never_altered_by_budget():
    summary, detail = "move it " * 60, "d " * 60

    async def go():
        svc = Service("s", "S", trust=[PRINCIPAL.public])
        svc.intent("x.many", "m")(lambda ctx: [Plan(summary, [create("card", detail)], lambda c: None, data={"k": 1}) for _ in range(6)])
        r = await Client(local(svc)).intent("x.many", budget=500)
        assert est(r.lens) <= 500 and r.more[0]["path"] == "proposals"
        assert 0 < len(r.proposals) < 6
        for p in r.proposals:
            assert p["summary"] == summary and p["effects"][0]["detail"] == detail

    run(go())


def test_budget_elides_proposal_data_before_dropping_proposals():
    async def go():
        svc = Service("s", "S", trust=[PRINCIPAL.public])
        svc.intent("x.one", "o")(lambda ctx: [Plan("do it", [], lambda c: None, data={"rows": list(range(2000))}) for _ in range(2)])
        r = await Client(local(svc)).intent("x.one", budget=300)
        assert len(r.proposals) == 2 and est(r.lens) <= 300
        assert {m["path"] for m in r.more} == {"proposals.0.data.rows", "proposals.1.data.rows"}

    run(go())


# ------------------------------------------------------------ transports


async def _tcp_and_http():
    svc = calendar([PRINCIPAL.public])
    tcp = await serve_tcp(svc, "127.0.0.1", 0)
    http = await serve_http(svc, "127.0.0.1", 0)
    return svc, tcp, http, tcp.sockets[0].getsockname()[1], http.sockets[0].getsockname()[1]


def _flow_against(url_of):
    async def go():
        svc, tcp, http, tport, hport = await _tcp_and_http()
        try:
            url = url_of(tport, hport)
            g = grant({"svc": ["calendar.example"]}, {"can": ["calendar.*"]})
            async with await connect(url, key=AGENT.seed, grants=[g]) as c:
                brief = await c.hello()
                assert brief.kind == "BRIEF" and c.service_id == "calendar.example"
                clar = await c.intent("calendar.reschedule", {"event": "Ana"})
                assert clar.kind == "CLARIFY"
                props = await c.intent("calendar.reschedule", {"event": "Ana", **clar.options[0]["params"]})
                events = []
                rc = await c.commit(props.proposals[0], on_event=events.append)
                assert rc.kind == "RECEIPT", rc.lens
                assert (await c.commit(props.proposals[0])).replay is True
                assert (await c.undo(rc.receipt["id"])).receipt["undoes"] == rc.receipt["id"]
                # Concurrency on one connection: replies are correlated by `re`.
                rs = await asyncio.gather(*(c.ask("calendar.free", {"day": "2030-01-0" + str(i)}) for i in range(1, 8)))
                assert [r.data["day"] for r in rs] == [f"2030-01-0{i}" for i in range(1, 8)]
        finally:
            tcp.close()
            http.close()

    run(go())


def test_tcp_flow():
    _flow_against(lambda t, h: f"yea://127.0.0.1:{t}")


def test_http_flow():
    _flow_against(lambda t, h: f"http://127.0.0.1:{h}/yea")


def test_http_discovery_and_raw_bad_frames():
    async def go():
        svc, tcp, http, tport, hport = await _tcp_and_http()
        try:
            def get(path):
                with urllib.request.urlopen(f"http://127.0.0.1:{hport}{path}") as r:
                    return r.headers["Content-Type"], json.loads(r.read())

            ctype, brief = await asyncio.to_thread(get, "/.well-known/yea")
            assert ctype == "application/json" and brief["kind"] == "BRIEF" and brief["endpoint"] == "/yea"
            reader, writer = await asyncio.open_connection("127.0.0.1", tport)
            writer.write(b"not json\n{\"yea\":1,\"id\":\"x\",\"verb\":\"NOPE\"}\n")
            await writer.drain()
            replies = [json.loads(await reader.readline()) for _ in range(2)]
            assert sorted(r["re"] for r in replies) == ["?", "x"]
            assert all(r["code"] == "bad_frame" for r in replies)
            writer.close()
        finally:
            tcp.close()
            http.close()

    run(go())


def test_stdio_flow():
    async def go():
        serve = ROOT / "examples" / "serve.py"
        c = await connect(f"stdio:{sys.executable} {serve} --stdio", key=AGENT)
        try:
            assert (await c.hello()).frame["service"]["id"] == "calendar.example"
            assert (await c.ask("calendar.agenda", {"query": "planning"})).data[0]["id"] == "e8"
        finally:
            await c.close()

    run(go())


# ------------------------------------------------------------ auto-commit (§4.3.1)


def _auto_shop():
    svc = shop()
    svc.intent("shop.final", "Irreversible", {})(lambda ctx: Plan("final", [], lambda c: "done"))
    return svc


def test_auto_commits_when_policy_allows():
    async def go():
        svc = _auto_shop()
        c = Client(local(svc), key=AGENT, grants=[grant({"each": {"of": "spend", "max": 5000, "scale": 2, "unit": "USD"}})])
        events = []
        r = await c.intent("shop.order", {"sku": "a", "qty": 1}, auto=True, on_event=events.append)
        assert r.kind == "RECEIPT" and r.auto is True and svc.orders == [1]
        assert r.lens.splitlines()[1] == "  + create card/default — 1 items"  # auto receipts show effects
        assert [e.kind for e in events] == ["EVENT"]
        # Over the per-commit cap: needs consent, so no auto; plain proposals come back.
        big = await c.intent("shop.order", {"sku": "a", "qty": 4}, auto=True)
        assert big.kind == "PROPOSALS" and svc.orders == [1]
        # Irreversible: never auto.
        assert (await c.intent("shop.final", auto=True)).kind == "PROPOSALS"
        # No grants: never auto.
        assert (await Client(local(svc)).intent("shop.order", {"sku": "a", "qty": 1}, auto=True)).kind == "PROPOSALS"

    run(go())


def test_auto_replay_returns_original_reply():
    async def go():
        svc = _auto_shop()
        c = Client(local(svc), key=AGENT, grants=[grant()])
        frames = []

        class Spy:
            async def request(self, frame, on_event):
                frames.append(frame)
                return await local(svc).request(frame, on_event)

            async def close(self):
                pass

        spy = Client(Spy(), key=AGENT, grants=[grant()])
        first = await spy.intent("shop.order", {"sku": "a", "qty": 1}, auto=True)
        assert first.kind == "RECEIPT" and svc.orders == [1]
        captured = frames[-1]
        again = await local(svc).request(captured, None)  # replayed verbatim
        assert again.replay is True and again.receipt["id"] == first.receipt["id"] and svc.orders == [1]
        # Same id, new params: still the cached reply, never a new commit.
        tampered = await local(svc).request({**captured, "params": {"sku": "a", "qty": 3}}, None)
        assert tampered.receipt["id"] == first.receipt["id"] and svc.orders == [1]
        # New id with the old proof: the proof no longer verifies.
        forged = await local(svc).request({**captured, "id": "c999"}, None)
        assert forged.code == "unauthorized" and svc.orders == [1]
        assert c  # a normal client still works alongside
        assert (await c.intent("shop.order", {"sku": "a", "qty": 1}, auto=True)).kind == "RECEIPT"
        assert svc.orders == [1, 1]

    run(go())


def test_forged_proof_never_replays_an_auto_intent():
    """Only a missing, null or empty ``grants`` is none; anything else that isn't a list of strings
    is a bad_frame. A replayed auto INTENT whose proof was never verified must not get the original
    receipt back (TS read a sparse ``grants`` as none but keyed the replay on its unverified proof)."""
    async def go():
        svc = _auto_shop()
        frames = []

        class Spy:
            async def request(self, frame, on_event):
                frames.append(frame)
                return await local(svc).request(frame, on_event)

            async def close(self):
                pass

        first = await Client(Spy(), key=AGENT, grants=[grant()]).intent("shop.order", {"sku": "a", "qty": 1}, auto=True)
        assert first.kind == "RECEIPT"
        forged = {"key": AGENT.public, "ts": int(time.time()), "sig": "A" * 86}
        for grants in ({}, 0, "", False, [None], ["pg1.x", 1]):
            r = await svc.handle({**frames[-1], "grants": grants, "proof": forged})
            assert (r["kind"], r.get("code"), r.get("message")) == (
                "ERROR", "bad_frame", "`grants` must be a list of strings"), grants
        for grants in ([], None):
            r = await svc.handle({**frames[-1], "grants": grants, "proof": forged})
            assert r["kind"] == "PROPOSALS", grants
        assert svc.orders == [1]

    run(go())


def test_tls_flow(tmp_path):
    import ssl
    import subprocess

    key, cert = tmp_path / "k.pem", tmp_path / "c.pem"
    r = subprocess.run(
        ["openssl", "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "1",
         "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost", "-keyout", str(key), "-out", str(cert)],
        capture_output=True,
    )
    if r.returncode:
        pytest.skip("openssl unavailable")
    server_ctx = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
    server_ctx.load_cert_chain(cert, key)
    client_ctx = ssl.create_default_context(cafile=str(cert))

    async def go():
        srv = await serve_tcp(calendar([PRINCIPAL.public]), "127.0.0.1", 0, ssl=server_ctx)
        port = srv.sockets[0].getsockname()[1]
        try:
            async with await connect(f"yeas://localhost:{port}", ssl_context=client_ctx) as c:
                assert (await c.hello()).frame["service"]["id"] == "calendar.example"
        finally:
            srv.close()

    run(go())


# ------------------------------------------------------------ security round (SPEC §2.1, §4.3.1, §4.4, §4.6, §6.3)


def test_replay_ignores_spent_limits_but_not_principal():
    async def go():
        svc = shop()
        other_principal = key_from_seed(bytes([9]) * 32)
        svc.trust.append(other_principal.public)
        c = Client(local(svc), key=AGENT, grants=[grant({"each": {"of": "spend", "max": 5000, "scale": 2, "unit": "USD"}})])
        p = (await c.intent("shop.order", {"sku": "a", "qty": 4})).proposals[0]  # 6000: needs consent
        need = await c.commit(p)
        first = await c.commit(p, grants=[consent_grant(PRINCIPAL, AGENT.public, need.consent)])
        assert first.kind == "RECEIPT"
        # A retry after a lost response, with only the normal grant: a replay, not a consent prompt.
        again = await c.commit(p)
        assert again.replay is True and again.receipt["id"] == first.receipt["id"] and svc.orders == [4]
        # Another principal's grant can't read the receipt by replaying.
        assert (await Client(local(svc), key=AGENT, grants=[grant(iss=other_principal)]).commit(p)).code == "forbidden"

    run(go())


def test_spend_is_reserved_before_apply_and_released_on_failure():
    async def go():
        svc = Service("s", "S", trust=[PRINCIPAL.public])
        gate = asyncio.Event()
        fail = {"on": False}

        async def apply(c):
            await gate.wait()
            if fail["on"]:
                raise RuntimeError("card declined")
            return "ok"

        svc.intent("x.buy", "b")(lambda ctx: Plan("buy", [create("charge/card")], apply, uses={"spend": spend("6.00", "USD")}))
        g = grant({"total": {"of": "spend", "max": 1000, "scale": 2, "unit": "USD"}})
        c = Client(local(svc), key=AGENT, grants=[g])
        p1, p2 = [(await c.intent("x.buy")).proposals[0] for _ in range(2)]
        # Both pass the check alone (600 <= 1000) but not together; the second must not start.
        t1 = asyncio.create_task(c.commit(p1))
        await asyncio.sleep(0)
        r2 = await c.commit(p2)
        assert r2.code == "consent_required"  # t1's reservation is already counted
        gate.set()
        assert (await t1).kind == "RECEIPT"
        key = (g.block_ids[0], "spend")
        assert svc._spent[key] == value(spend("6.00", "USD"))
        # A failed apply releases its reservation.
        fail["on"] = True
        p3 = (await c.intent("x.buy")).proposals[0]
        assert (await c.commit(p3)).code == "consent_required"  # 600 + 600 > 1000, regardless
        svc._spent[key] = 0
        assert (await c.commit(p3)).code == "internal" and svc._spent[key] == 0

    run(go())


def test_expand_is_bound_to_the_requesting_key():
    async def go():
        svc = shop()
        mine = Client(local(svc), key=AGENT, grants=[grant()])
        r = await mine.ask("shop.catalog", budget=300)
        h = r.more[0]["handle"]
        assert (await Client(local(svc)).expand(h)).code == "unauthorized"
        assert (await Client(local(svc), key=OTHER, grants=[grant(sub=OTHER)]).expand(h)).code == "unauthorized"
        assert (await mine.expand(h)).kind == "ANSWER"
        anon = await Client(local(svc)).ask("shop.catalog", budget=300)
        assert (await Client(local(svc)).expand(anon.more[0]["handle"])).kind == "ANSWER"  # anonymous stays open

    run(go())


def test_concurrent_failing_undos_each_get_their_own_re():
    async def go():
        svc = Service("s", "S", trust=[PRINCIPAL.public])
        gate = asyncio.Event()

        async def revert(c):
            await gate.wait()
            raise RuntimeError("provider down")

        svc.intent("x.do", "d")(lambda ctx: Plan("do", [], lambda c: None, revert=revert))
        c = Client(local(svc), key=AGENT, grants=[grant()])
        rc = await c.commit((await c.intent("x.do")).proposals[0])
        frames = [{"yea": 1, "id": f"u{i}", "verb": "UNDO", "receipt": rc.receipt["id"], "grants": c.grants,
                   "proof": sign_proof(AGENT, "s", "UNDO", rc.receipt["id"], int(time.time()))} for i in range(3)]
        tasks = [asyncio.create_task(svc.handle(f)) for f in frames]
        await asyncio.sleep(0)
        gate.set()
        replies = await asyncio.gather(*tasks)
        assert [r["re"] for r in replies] == ["u0", "u1", "u2"] and all(r["code"] == "internal" for r in replies)

    run(go())


def test_auto_dedupe_outlives_the_proof():
    async def go():
        clock = [1_790_000_000]
        svc = Service("s", "S", trust=[PRINCIPAL.public], now=lambda: clock[0])
        svc.intent("x.do", "d")(lambda ctx: Plan("do", [], lambda c: None, revert=lambda c: None))
        frame = {"yea": 1, "id": "c_fixed", "verb": "INTENT", "capability": "x.do", "auto": True,
                 "grants": [str(grant())], "proof": sign_proof(AGENT, "s", "INTENT", "auto:x.do:c_fixed", clock[0] + 300)}
        first = await svc.handle(frame)
        assert first["kind"] == "RECEIPT"
        clock[0] += 599  # proof ts is now+300, still valid; the old 600s memory would have been close
        assert (await svc.handle(frame))["replay"] is True
        assert svc._auto_seen["%s:c_fixed" % AGENT.public][1] == 1_790_000_000 + 300 + 900

    run(go())


def test_oversized_frames_and_inflight_cap_over_tcp():
    async def go():
        svc = Service("s", "S")
        gate = asyncio.Event()

        async def slow(ctx):
            await gate.wait()
            return 1

        svc.ask("x.slow", "s")(slow)
        srv = await serve_tcp(svc, "127.0.0.1", 0)
        port = srv.sockets[0].getsockname()[1]
        try:
            reader, writer = await asyncio.open_connection("127.0.0.1", port)
            writer.write(b'{"pad":"' + b"x" * (1 << 20) + b'"}\n')
            writer.write(b'{"yea":1,"id":"after","verb":"HELLO"}\n')
            await writer.drain()
            r1, r2 = [json.loads(await reader.readline()) for _ in range(2)]
            assert r1["code"] == "bad_frame" and r2["re"] == "after" and r2["kind"] == "BRIEF"  # still usable
            assert (r1["id"], r1["message"]) == ("s_err", "frame exceeds 1 MiB")  # as ts/src/node.ts
            for i in range(65):
                writer.write(json.dumps({"yea": 1, "id": f"q{i}", "verb": "ASK", "capability": "x.slow"}).encode() + b"\n")
            await writer.drain()
            over = json.loads(await reader.readline())
            assert over["re"] == "q64" and over["code"] == "limit"
            assert (over["id"], over["message"], over["retry"]) == (
                "s_busy", "more than 64 requests in flight on this connection", 1)
            gate.set()
            done = [json.loads(await reader.readline()) for _ in range(64)]
            assert {d["re"] for d in done} == {f"q{i}" for i in range(64)}
            writer.close()

            def post_big():
                req = urllib.request.Request(f"http://127.0.0.1:{hport}/yea", data=b"x" * ((1 << 20) + 1), method="POST")
                try:
                    urllib.request.urlopen(req)
                except urllib.error.HTTPError as e:
                    return e.code, e.read()

            http = await serve_http(svc, "127.0.0.1", 0)
            hport = http.sockets[0].getsockname()[1]
            assert await asyncio.to_thread(post_big) == (413, b"frame exceeds 1 MiB")

            def get_other():
                try:
                    urllib.request.urlopen(f"http://127.0.0.1:{hport}/nope")
                except urllib.error.HTTPError as e:
                    return e.code, e.read()
            assert await asyncio.to_thread(get_other) == (404, b"not a yea endpoint")
            http.close()
        finally:
            srv.close()

    run(go())


def test_a_reply_that_cant_be_serialized_still_gets_a_final_reply():
    """§2.2: exactly one final reply. NaN can't be written as JSON, so the reply becomes an ERROR
    rather than a hung stream or a cut-off HTTP body (#146, as ts/src/node.ts and http.ts do)."""
    svc = Service("odd.example", "Odd")

    @svc.ask("odd.nan")
    def nan(ctx):
        return float("nan")

    @svc.ask("odd.ok")
    def ok(ctx):
        return 1

    async def go():
        tcp = await serve_tcp(svc, "127.0.0.1", 0)
        http = await serve_http(svc, "127.0.0.1", 0)
        try:
            for url in (f"yea://127.0.0.1:{tcp.sockets[0].getsockname()[1]}",
                        f"http://127.0.0.1:{http.sockets[0].getsockname()[1]}/yea"):
                async with await connect(url, key=AGENT.seed) as c:
                    r = await asyncio.wait_for(c.ask("odd.nan"), 5)
                    assert (r.kind, r.code, r.message, r.frame["id"]) == (
                        "ERROR", "internal", "reply could not be serialized", "s_err"), url
                    assert r.frame["re"] and "retry" not in r.frame  # as TS's errorLine
                    assert (await c.ask("odd.ok")).data == 1  # the connection still works
        finally:
            tcp.close()
            http.close()

    run(go())


def test_an_event_that_cant_be_serialized_is_dropped_and_apply_runs_once():
    """A progress EVENT with NaN used to raise inside apply(); the commit then counted as failed and
    a retry ran apply() again. The EVENT is dropped instead, and the commit succeeds once (#146)."""
    svc = Service("odd.example", "Odd", trust=[PRINCIPAL.public])
    ran = []

    def apply(ctx):
        ctx.progress("half way", 0.5, float("nan"))
        ran.append(1)
        return {"ok": True}

    @svc.intent("odd.do")
    def do(ctx):
        return Plan("Do it", [create("thing")], apply=apply)

    async def go():
        tcp = await serve_tcp(svc, "127.0.0.1", 0)
        http = await serve_http(svc, "127.0.0.1", 0)
        try:
            for url in (f"yea://127.0.0.1:{tcp.sockets[0].getsockname()[1]}",
                        f"http://127.0.0.1:{http.sockets[0].getsockname()[1]}/yea"):
                g = grant({"svc": ["odd.example"]}, {"can": ["odd.*"]})
                async with await connect(url, key=AGENT.seed, grants=[g]) as c:
                    props = await c.intent("odd.do")
                    rc = await asyncio.wait_for(c.commit(props.proposals[0]), 5)
                    assert rc.kind == "RECEIPT", (url, rc.lens)
        finally:
            tcp.close()
            http.close()

    run(go())
    assert ran == [1, 1]  # once per transport, never re-run


def test_a_whole_number_float_budget_counts_like_the_integer():
    """JSON can't tell 300.0 from 300, and TS accepts both; so does Python (#148)."""
    from yea.lens import lens

    async def go():
        svc = shop()
        for budget in (300.0, 3e2):
            r = await svc.handle({"yea": 1, "id": "a1", "verb": "ASK", "capability": "shop.catalog", "budget": budget})
            assert r["kind"] == "ANSWER" and est(lens(r)) <= 300 and r.get("more"), budget
        for ignored in (True, 0.5, -300.0, float("inf")):  # the default budget (2000) applies
            r = await svc.handle({"yea": 1, "id": "a1", "verb": "ASK", "capability": "shop.catalog", "budget": ignored})
            assert est(lens(r)) > 300, ignored

    run(go())


def test_the_http_budget_query_reads_like_a_frame_budget():
    """?budget= follows the frame rule in decimal notation: 800.0 counts; -5, 0x10 and a non-ASCII
    digit get the default instead of a crash or a surprise (#148). The same table as TS (#193)."""
    from yea.transport import _query_budget

    assert [_query_budget(t) for t in ("800", "800.0", "1e3", "+800", ".8e3")] == [800, 800, 1000, 800, 800]
    rejected = ("", " ", "0", "-5", "0.5", "1.5", "inf", "Infinity", "-Infinity", "nan", "NaN", "1e400",
                "0x10", "0b11", "0o7", "1_000", " 800", "\u0663", "\u00b2", "\uff18\uff10\uff10",
                "1" * 15_000 + "x")
    assert [_query_budget(t) for t in rejected] == [None] * len(rejected)

    async def go():
        http = await serve_http(shop(), "127.0.0.1", 0)
        port = http.sockets[0].getsockname()[1]
        try:
            def brief(q):
                with urllib.request.urlopen(f"http://127.0.0.1:{port}/.well-known/yea{q}") as r:
                    return json.loads(r.read())
            small, same, signed, default, spaced = await asyncio.gather(*(asyncio.to_thread(brief, q) for q in (
                "?budget=40", "?budget=40.0", "?budget=%2B40", "?budget=%C2%B2", "?budget=+40")))
            # Fitted to 40 each way (exactly how much fits varies with the random ids it counts), and
            # the default budget for ², which used to close the connection with no response, and for
            # +40, since `+` in a query decodes to a space.
            assert small.get("more") and same.get("more") and signed.get("more")
            assert not default.get("more") and not spaced.get("more")
        finally:
            http.close()

    run(go())


def test_proof_failures_read_as_in_ts():
    """verify_proof's reasons are the TS core's strings (ts/src/proof.ts), as agents see them (#145)."""
    from yea.keys import sign_proof, verify_proof

    now = 1_790_000_000
    good = sign_proof(AGENT, "s", "ASK", "x", now)
    assert verify_proof(good, "s", "ASK", "x", now) is None
    assert verify_proof(None, "s", "ASK", "x", now) == "missing or malformed proof"
    assert verify_proof({**good, "ts": "1"}, "s", "ASK", "x", now) == "missing or malformed proof"
    assert verify_proof(good, "s", "ASK", "x", now + 301) == "proof timestamp is outside the 300s window"
    assert verify_proof(good, "s", "ASK", "y", now) == "proof signature is invalid"
    assert verify_proof({**good, "ts": 2**53}, "s", "ASK", "x", now) == "missing or malformed proof"  # not a safe integer


def test_an_in_flight_total_refusal_names_its_measure():
    """As ts/src/service/execute.ts: "<measure> would pass a total limit (other commits are in flight)" (#145)."""
    from yea.grants import GrantContext, verify_grant
    from yea.service.execute import reserve

    svc = shop()
    g = grant({"total": {"of": "spend", "max": 100, "scale": 2, "unit": "USD"}})
    from yea.uses import spend

    proposal = {"hash": "h", "risk": "low", "uses": {"spend": spend("0.60", "USD")}}
    auth = verify_grant(g, [PRINCIPAL.public], AGENT.public, GrantContext("shop.example", "COMMIT", "shop.order", 1, proposal))
    assert auth.ok, auth.message
    held, over = reserve(svc.state, proposal, auth)
    assert held and over is None
    held, over = reserve(svc.state, proposal, auth)  # 0.60 + 0.60 > 1.00
    assert held is None and over == "spend"


def test_a_forbidden_with_nothing_to_drop_sends_no_need():
    """The different-principal refusal has no caveats to drop; TS leaves `need` out, not [] (#145)."""
    from yea.grants import Verification

    assert Verification(False, "forbidden", "x").need is None
    assert Verification(False, "forbidden", "x", failed=[{"can": ["a"]}]).need == [{"can": ["a"]}]


def test_undo_swaps_only_the_sides_an_update_had():
    """§4.5: a side the original left out stays left out, never null; an explicit null still swaps (#159)."""
    from yea.service.undo import _inverse

    assert _inverse({"op": "update", "target": "t", "field": "f", "to": 2}) == {"op": "update", "target": "t", "field": "f", "from": 2}
    assert _inverse({"op": "update", "target": "t", "from": None, "to": 1}) == {"op": "update", "target": "t", "from": 1, "to": None}
    assert list(_inverse({"op": "update", "from": 1, "target": "t", "to": 2})) == ["op", "target", "from", "to"]  # as TS


def test_a_client_that_didnt_learn_the_service_id_signs_nothing():
    """§6.5: after a failed HELLO the client raises rather than sign for the audience "" (#159)."""
    svc = Service("s", "S")
    c = Client(local(svc), key=AGENT.seed, grants=[grant({"svc": ["s"]})])  # a grant, so it would sign

    async def failing_hello(budget=None):
        return None

    c.hello = failing_hello
    with pytest.raises(RuntimeError, match=r"did not identify itself \(HELLO failed\)"):
        run(c.undo("r_12345678"))


def _fake_server(reply_lines):
    """A TCP server that answers each request line with ``reply_lines(frame_id)`` (bytes)."""
    async def handle(reader, writer):
        while line := await reader.readline():
            writer.write(reply_lines(json.loads(line)["id"]))
            await writer.drain()
    return asyncio.start_server(handle, "127.0.0.1", 0)


def test_the_client_skips_a_bad_line_and_reads_a_reply_over_1_mib():
    """As TS's line transport: an unparseable line is dropped, not fatal to every pending request,
    and replies up to 16 MiB are read (the old 1 MiB reader limit killed the connection) (#147)."""
    big = "x" * (2 << 20)

    def lines(fid):
        final = {"yea": 1, "id": "s_1", "re": fid, "kind": "ANSWER", "data": big}
        odd = b'{"re": []}\n' + b"[" * 200_000 + b"\n"  # valid JSON of the wrong shape; nesting past the recursion limit
        return b"not json\n" + odd + json.dumps(final).encode() + b"\n"

    async def go():
        srv = await _fake_server(lines)
        try:
            async with await connect(f"yea://127.0.0.1:{srv.sockets[0].getsockname()[1]}") as c:
                r = await asyncio.wait_for(c.ask("x"), 5)
                assert r.kind == "ANSWER" and r.data == big
        finally:
            srv.close()

    run(go())


def test_a_reply_line_over_the_cap_fails_the_pending_requests(monkeypatch):
    """Past MAX_REPLY without a newline, the client gives up with TS's message instead of buffering on."""
    import yea.client.connection as conn

    monkeypatch.setattr(conn, "MAX_REPLY", 1000)

    async def go():
        srv = await _fake_server(lambda fid: b"x" * 5000)
        try:
            async with await connect(f"yea://127.0.0.1:{srv.sockets[0].getsockname()[1]}") as c:
                with pytest.raises(ConnectionError, match="reply exceeds 16 MiB without a newline"):
                    await asyncio.wait_for(c.ask("x"), 5)
        finally:
            srv.close()

    run(go())


def test_the_http_client_stops_at_the_final_reply_and_caps_a_line(monkeypatch):
    """The HTTP client reads line by line: EVENTs, then the final reply, and nothing after; a line
    past MAX_REPLY fails rather than being read whole (#147)."""
    import threading
    from http.server import BaseHTTPRequestHandler, HTTPServer

    import yea.client.transports as tr

    body = {"value": b""}

    class H(BaseHTTPRequestHandler):
        def do_POST(self):
            fid = json.loads(self.rfile.read(int(self.headers["Content-Length"])))["id"]
            self.send_response(200)
            self.end_headers()
            self.wfile.write(body["value"].replace(b"RE", fid.encode()))

        def log_message(self, *a):
            pass

    server = HTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{server.server_address[1]}/yea"
    try:
        body["value"] = (b'{"yea":1,"id":"e","re":"RE","kind":"EVENT","message":"half"}\n'
                         b'{"yea":1,"id":"s","re":"RE","kind":"ANSWER","data":1}\n'
                         b"trailing junk that is never read\n")
        events = []
        r = run(_ask_http(url, events))
        assert r.kind == "ANSWER" and r.data == 1 and [e.message for e in events] == ["half"]
        monkeypatch.setattr(tr, "MAX_REPLY", 100)
        body["value"] = b"y" * 1000
        with pytest.raises(ConnectionError, match="reply exceeds 16 MiB without a newline"):
            run(_ask_http(url, []))
    finally:
        server.shutdown()


async def _ask_http(url, events):
    from yea.client.transports import _HttpTransport

    return await _HttpTransport(url).request({"yea": 1, "id": "c_1", "verb": "ASK", "capability": "x"}, events.append)


def test_after_the_connection_fails_a_new_request_fails_at_once():
    """However the reader stops (here, an on_event callback that raises), the connection closes and
    a later request raises instead of waiting forever for a reply no one reads (#147 review)."""
    def lines(fid):
        event = {"yea": 1, "id": "e_1", "re": fid, "kind": "EVENT", "message": "half"}
        return json.dumps(event).encode() + b"\n"

    def boom(e):
        raise RuntimeError("callback failed")

    async def go():
        srv = await _fake_server(lines)
        try:
            async with await connect(f"yea://127.0.0.1:{srv.sockets[0].getsockname()[1]}") as c:
                with pytest.raises(RuntimeError, match="callback failed"):
                    await asyncio.wait_for(c.send({"verb": "ASK", "capability": "x", "params": {}}, boom), 5)
                with pytest.raises(RuntimeError, match="callback failed"):
                    await asyncio.wait_for(c.ask("y"), 5)  # used to hang: nothing read the replies
        finally:
            srv.close()


def test_old_proposals_receipts_and_replays_are_swept():
    """Memory stays bounded: every 100th INTENT (or at 5000 proposals) forgets uncommitted
    proposals an hour past expiry and receipts a day past their undo window, as TS's Sweeper."""
    clock = [int(time.time())]  # proofs carry real time, so the commit happens before the clock moves

    async def go():
        svc = Service("s", "S", trust=[PRINCIPAL.public], now=lambda: clock[0])

        @svc.intent("s.do")
        def do(ctx):
            return Plan("Do", [create("x")], apply=lambda c: None, revert=lambda c: None, undo_window=60)

        c = Client(local(svc), key=AGENT.seed, grants=[grant({"svc": ["s"]})])
        kept = (await c.intent("s.do")).proposals[0]
        assert (await c.commit(kept)).kind == "RECEIPT"
        anon = Client(local(svc))  # INTENT needs no grant here, so later calls don't need fresh proofs
        stale = (await anon.intent("s.do")).proposals[0]
        clock[0] += 2 * 3600  # both proposals expired over an hour ago; the receipt is kept until its until + a day
        for _ in range(97):  # INTENTs 3-99
            await anon.intent("s.do")
        assert stale["id"] in svc._proposals  # no sweep before the 100th INTENT
        await anon.intent("s.do")
        assert stale["id"] not in svc._proposals  # uncommitted and an hour past expiry: forgotten
        assert kept["id"] in svc._proposals and len(svc._receipts) == 1  # committed: kept with its receipt
        clock[0] += 86400
        svc._auto_seen["key:old"] = (None, clock[0] - 1)  # an auto-INTENT replay past its memory
        for _ in range(100):
            await anon.intent("s.do")
        assert kept["id"] not in svc._proposals and svc._receipts == {} and kept["id"] not in svc._commits
        assert len(svc._proposals) <= 100 and "key:old" not in svc._auto_seen

    run(go())


def test_a_request_with_a_lone_surrogate_is_a_bad_frame(caplog):
    """An INTENT whose params held a lone surrogate reached the proposal hash, raised there and came
    back as ``internal`` with ``retry: 5``, logged as a service failure. It is the client's mistake,
    so the frame is refused as ``bad_frame`` before any handler runs (SPEC §10, #160)."""
    svc = Service("mail.example", "Mail")

    @svc.intent("mail.send")
    def send(ctx):
        return Plan(f"send {ctx.params.get('to')}", [], apply=lambda _ctx: None)  # the params reach the hash

    def intent(params):
        return run(svc.handle({"yea": 1, "id": "c1", "verb": "INTENT", "capability": "mail.send", "params": params}))

    for params in ({"to": "a\ud800"}, {"\udfff": 1}, {"list": [{"deep": ["ok", "\udc00"]}]}):
        r = intent(params)
        assert (r["kind"], r["code"], r["message"], "retry" in r) == ("ERROR", "bad_frame", "a string holds a lone surrogate", False)
    assert not [rec for rec in caplog.records if rec.name == "yea"]
    # A surrogate pair is well-formed, so the frame is planned as usual.
    assert intent({"to": "🎉"})["kind"] == "PROPOSALS"


def test_a_reply_keeps_only_the_most_recent_events_and_on_event_sees_them_all():
    """A service can't grow the client's memory with EVENTs: the Reply keeps the most recent
    KEEP_EVENTS and counts the rest; on_event still sees every one, on every transport (#175)."""
    from yea.client.reply import KEEP_EVENTS

    svc = Service("chatty.example", "Chatty", trust=[PRINCIPAL.public])

    def apply(ctx):
        for i in range(200):
            ctx.progress(f"step {i}", i / 200)

    @svc.intent("chatty.do")
    def do(ctx):
        return Plan("Do it", [create("thing")], apply=apply)

    async def go():
        tcp = await serve_tcp(svc, "127.0.0.1", 0)
        http = await serve_http(svc, "127.0.0.1", 0)
        try:
            for how in ("local", "tcp", "http"):
                g = grant({"svc": ["chatty.example"]}, {"can": ["chatty.*"]})
                url = {"tcp": f"yea://127.0.0.1:{tcp.sockets[0].getsockname()[1]}",
                       "http": f"http://127.0.0.1:{http.sockets[0].getsockname()[1]}/yea"}.get(how)
                c = Client(local(svc), key=AGENT.seed, grants=[g]) if how == "local" else await connect(
                    url, key=AGENT.seed, grants=[g])
                async with c:
                    props = await c.intent("chatty.do")
                    seen = []
                    rc = await asyncio.wait_for(c.commit(props.proposals[0], on_event=seen.append), 10)
                assert rc.kind == "RECEIPT", how
                assert len(seen) == 200 and len(rc.events) == KEEP_EVENTS, how
                assert rc.events_dropped == 200 - KEEP_EVENTS and rc.events[-1].message == "step 199", how
        finally:
            tcp.close()
            http.close()

    run(go())


def test_http_events_reach_on_event_before_the_final_reply():
    """The HTTP client passes each EVENT on as it arrives, as TS does, not after the whole body."""
    import threading
    from http.server import BaseHTTPRequestHandler, HTTPServer

    from yea.client.transports import _HttpTransport

    release, answered_after_event = threading.Event(), []

    class H(BaseHTTPRequestHandler):
        def do_POST(self):
            fid = json.loads(self.rfile.read(int(self.headers["Content-Length"])))["id"]
            self.send_response(200)
            self.end_headers()
            self.wfile.write(f'{{"yea":1,"id":"e","re":"{fid}","kind":"EVENT","message":"half"}}\n'.encode())
            self.wfile.flush()
            answered_after_event.append(release.wait(5))  # the final reply only once the client has seen the EVENT
            self.wfile.write(f'{{"yea":1,"id":"s","re":"{fid}","kind":"ANSWER","data":1}}\n'.encode())

        def log_message(self, *a):
            pass

    server = HTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        seen = []

        def on_event(ev):
            seen.append(ev.message)
            release.set()

        r = run(_HttpTransport(f"http://127.0.0.1:{server.server_address[1]}/yea").request(
            {"yea": 1, "id": "c_1", "verb": "ASK", "capability": "x"}, on_event))
        assert seen == ["half"] and r.kind == "ANSWER" and answered_after_event == [True]
    finally:
        release.set()
        server.shutdown()


def _http_server(body):
    """An HTTP server that answers each POST with ``body(frame_id, write)``; returns (url, server, sent)."""
    import threading
    from http.server import BaseHTTPRequestHandler, HTTPServer

    sent = []

    class H(BaseHTTPRequestHandler):
        def do_POST(self):
            fid = json.loads(self.rfile.read(int(self.headers["Content-Length"])))["id"]
            self.send_response(200)
            self.end_headers()

            def write(line):
                self.wfile.write(line.encode() + b"\n")
                sent.append(1)
            try:
                body(fid, write)
            except (BrokenPipeError, ConnectionResetError):
                pass  # the client stopped reading

        def log_message(self, *a):
            pass

    server = HTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return f"http://127.0.0.1:{server.server_address[1]}/yea", server, sent


def _event(fid, i, pad=""):
    return json.dumps({"yea": 1, "id": f"e{i}", "re": fid, "kind": "EVENT", "message": f"step {i}{pad}"})


def _ask_http_with(url, on_event):
    from yea.client.transports import _HttpTransport

    return _HttpTransport(url).request({"yea": 1, "id": "c_1", "verb": "ASK", "capability": "x"}, on_event)


def test_a_slow_on_event_holds_an_http_flood_back_instead_of_buffering_it():
    """The reading thread waits for the loop to take each line, so memory stays bounded however
    many EVENTs a server sends, as TS's readFinal lets the socket hold the server back (#175)."""
    import tracemalloc

    def body(fid, write):
        for i in range(5000):
            write(_event(fid, i, "x" * 1000))
        write(json.dumps({"yea": 1, "id": "s", "re": fid, "kind": "ANSWER", "data": 1}))

    url, server, _ = _http_server(body)
    seen = []

    async def slow(ev):
        seen.append(1)
        await asyncio.sleep(0)

    try:
        tracemalloc.start()
        r = run(_ask_http_with(url, slow))
        peak = tracemalloc.get_traced_memory()[1]
        tracemalloc.stop()
    finally:
        server.shutdown()
    assert r.kind == "ANSWER" and len(seen) == 5000 and r.events_dropped == 5000 - 64
    assert peak < 2 << 20, peak  # a few MiB of EVENTs were never all held at once


def test_an_on_event_that_raises_stops_the_http_reading_thread():
    """The error reaches the caller, and the thread stops reading instead of draining the body."""
    def body(fid, write):
        for i in range(20_000):
            write(_event(fid, i, "x" * 500))

    url, server, sent = _http_server(body)

    def boom(ev):
        raise RuntimeError("the callback failed")

    try:
        with pytest.raises(RuntimeError, match="the callback failed"):
            run(_ask_http_with(url, boom))
        time.sleep(1)
        assert len(sent) < 20_000  # the server was cut off, not read to the end
    finally:
        server.shutdown()


def test_an_http_stream_without_a_final_reply_and_a_null_line():
    """EVENTs then a close is "closed without a final reply", as TS says; a JSON null line is dropped."""
    def events_only(fid, write):
        write(_event(fid, 1))

    def with_null(fid, write):
        write("null")
        write(json.dumps({"yea": 1, "id": "s", "re": fid, "kind": "ANSWER", "data": 1}))

    url, server, _ = _http_server(events_only)
    try:
        with pytest.raises(ConnectionError, match="closed without a final reply"):
            run(_ask_http_with(url, None))
    finally:
        server.shutdown()
    url, server, _ = _http_server(with_null)
    try:
        assert run(_ask_http_with(url, None)).data == 1
    finally:
        server.shutdown()


def test_a_long_stall_in_on_event_delivers_each_http_event_once():
    """A synchronous on_event that blocks the loop for longer than the thread's wait doesn't make
    the thread hand the same line again: each EVENT arrives once, in order (#175 review)."""
    def body(fid, write):
        for i in range(20):
            write(_event(fid, i))
        write(json.dumps({"yea": 1, "id": "s", "re": fid, "kind": "ANSWER", "data": 1}))

    url, server, _ = _http_server(body)
    seen = []

    def blocking(ev):
        seen.append(ev.message)
        if len(seen) == 1:
            time.sleep(1.2)  # over two of the thread's 0.5 s waits

    try:
        r = run(_ask_http_with(url, blocking))
    finally:
        server.shutdown()
    assert r.kind == "ANSWER" and seen == [f"step {i}" for i in range(20)]
