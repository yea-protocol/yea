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
        assert r.code == "forbidden" and r.need == [{"can": ["calendar.*"]}]
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
            for i in range(65):
                writer.write(json.dumps({"yea": 1, "id": f"q{i}", "verb": "ASK", "capability": "x.slow"}).encode() + b"\n")
            await writer.drain()
            over = json.loads(await reader.readline())
            assert over["re"] == "q64" and over["code"] == "limit"
            gate.set()
            done = [json.loads(await reader.readline()) for _ in range(64)]
            assert {d["re"] for d in done} == {f"q{i}" for i in range(64)}
            writer.close()

            def post_big():
                req = urllib.request.Request(f"http://127.0.0.1:{hport}/yea", data=b"x" * ((1 << 20) + 1), method="POST")
                try:
                    urllib.request.urlopen(req)
                except urllib.error.HTTPError as e:
                    return e.code

            http = await serve_http(svc, "127.0.0.1", 0)
            hport = http.sockets[0].getsockname()[1]
            assert await asyncio.to_thread(post_big) == 413
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
