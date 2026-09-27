"""``uses`` quantities (SPEC §5.1), ``each``/``total`` limits (§6.3) and their Lens (§9.2)."""

import asyncio

import pytest

from yea import Client, GrantContext, Plan, Service, create, fmt_quantity, issue_grant, key_from_seed, lens, local, quantity, spend, verify_grant
from yea.uses import MAX_AMOUNT, fmt_uses, is_limit, is_uses, value

ALICE = key_from_seed(bytes(32))
AGENT = key_from_seed(bytes([1]) * 32)
NOW = 1_790_000_000


def check(caveat, uses=None, spent=None):
    """Verify a one-caveat grant for a COMMIT of a proposal with ``uses``."""
    g = issue_grant(ALICE, AGENT.public, [caveat], iat=NOW)
    proposal = {"hash": "H", "risk": "low", **({"uses": uses} if uses is not None else {})}
    ctx = GrantContext("svc", "COMMIT", "shop.buy", NOW, proposal, spent or {})
    return verify_grant(g, [ALICE.public], AGENT.public, ctx)


def test_quantity_is_minimal():
    assert quantity(1) == {"amount": 1}
    assert quantity(5, scale=0, unit="GB") == {"amount": 5, "unit": "GB"}
    assert quantity(2287, scale=2, unit="USD") == {"amount": 2287, "scale": 2, "unit": "USD"}
    for bad in [lambda: quantity(-1), lambda: quantity(MAX_AMOUNT + 1), lambda: quantity(1, scale=19), lambda: quantity(1, unit="U S")]:
        with pytest.raises(ValueError):
            bad()


def test_spend_takes_scale_from_the_digits_written():
    assert spend("22.87", "USD") == {"amount": 2287, "scale": 2, "unit": "USD"}
    assert spend("100", "USD") == {"amount": 100, "unit": "USD"}
    assert spend("22.9", "USD") == {"amount": 229, "scale": 1, "unit": "USD"}
    assert spend("100.00", "USD") == {"amount": 10000, "scale": 2, "unit": "USD"}
    for bad in ["-1", "1e3", "1.", ".5", " 1", "١"]:
        with pytest.raises(ValueError):
            spend(bad, "USD")


def test_fmt_quantity():
    assert fmt_quantity({"amount": 2290, "scale": 2, "unit": "USD"}) == "22.90 USD"
    assert fmt_quantity({"amount": 5, "scale": 3}) == "0.005"
    assert fmt_quantity({"amount": 1}) == "1"
    assert fmt_quantity({"amount": 0, "scale": 2}) == "0.00"
    assert fmt_quantity({"amount": 1, "scale": 18}) == "0.000000000000000001"
    assert fmt_uses({"spend": spend("22.90", "USD"), "emails": quantity(1)}) == "emails 1, spend 22.90 USD"
    assert fmt_uses({}) is None and fmt_uses(None) is None


@pytest.mark.parametrize("uses,ok", [
    (None, True), ({}, True), ({"constructor": {"amount": 1}}, True),
    ({"Spend": {"amount": 1}}, False), ({"1x": {"amount": 1}}, False), ({"a" * 65: {"amount": 1}}, False),
    ({"x": {"amount": 1, "extra": 1}}, False), ({"x": {"amount": 1.0}}, False), ({"x": {"amount": True}}, False),
    ({"x": {"amount": 1, "scale": 19}}, False), ({"x": {"amount": 1, "unit": ""}}, False), ([], False),
])
def test_is_uses(uses, ok):
    assert is_uses(uses) is ok


def test_is_limit():
    assert is_limit({"of": "spend", "max": 25, "unit": "USD"})
    assert not is_limit({"of": "spend", "max": 25, "currency": "USD"})  # the old shape
    assert not is_limit({"max": 25})
    assert not is_limit({"of": "spend", "max": 25, "scale": 19})
    assert not is_limit({"of": "spend", "max": MAX_AMOUNT + 1})


def test_values_compare_exactly_across_scales():
    assert value(quantity(100)) == value(quantity(10000, scale=2))
    usd25 = {"each": {"of": "spend", "max": 25, "unit": "USD"}}  # scale 0, against cents
    assert check(usd25, {"spend": spend("25.00", "USD")}).ok
    assert check(usd25, {"spend": spend("25.001", "USD")}).code == "consent_required"
    # Far past 2^53 once scaled: still exact.
    big = {"each": {"of": "n", "max": MAX_AMOUNT}}
    assert check(big, {"n": {"amount": MAX_AMOUNT * 10**0}}).ok
    assert check(big, {"n": {"amount": MAX_AMOUNT, "scale": 18}}).ok


def test_each_and_total_reasons():
    each = {"each": {"of": "spend", "max": 2500, "scale": 2, "unit": "USD"}}
    r = check(each, {"spend": spend("25.01", "USD")})
    assert r.code == "consent_required" and "spend over the per-commit limit of 25.00 USD" in r.message
    total = {"total": {"of": "emails", "max": 20}}
    g = issue_grant(ALICE, AGENT.public, [total], iat=NOW)
    ctx = GrantContext("svc", "COMMIT", "mail.send", NOW, {"hash": "H", "risk": "low", "uses": {"emails": quantity(1)}},
                       {(g.id, "emails"): value(quantity(20))})
    r = verify_grant(g, [ALICE.public], AGENT.public, ctx)
    assert r.code == "consent_required" and "emails would pass the total limit of 20" in r.message


@pytest.mark.parametrize("q,limit_unit,why", [
    ({"amount": 1}, "USD", "spend is in no unit, but the limit is in USD"),
    ({"amount": 1, "unit": "USD"}, None, "spend is in USD, but the limit is in no unit"),
    ({"amount": 1, "unit": "EUR"}, "USD", "spend is in EUR, but the limit is in USD"),
])
def test_unit_mismatch_is_soft(q, limit_unit, why):
    for kind in ("each", "total"):
        limit = {"of": "spend", "max": 1000, **({"unit": limit_unit} if limit_unit else {})}
        r = check({kind: limit}, {"spend": q})
        assert r.code == "consent_required" and why in r.message


def test_limits_bind_only_what_is_reported():
    for kind in ("each", "total"):
        cav = {kind: {"of": "spend", "max": 0, "unit": "USD"}}
        assert check(cav).ok
        assert check(cav, {"emails": quantity(3)}).ok


def test_malformed_uses_is_hard():
    r = check({"each": {"of": "spend", "max": 1}}, {"spend": {"amount": -1}})
    assert r.code == "forbidden" and "malformed uses on the proposal" in r.message
    # Even when the malformed entry isn't the one limited.
    assert check({"total": {"of": "spend", "max": 1}}, {"emails": {"amount": 1.5}}).code == "forbidden"
    # A malformed limit is hard too.
    assert check({"each": {"of": "spend", "max": 1, "scale": 19}}, {"spend": quantity(1)}).code == "forbidden"


def test_limits_are_ignored_outside_commit():
    g = issue_grant(ALICE, AGENT.public, [{"each": {"of": "spend", "max": 0}}], iat=NOW)
    assert verify_grant(g, [ALICE.public], AGENT.public, GrantContext("svc", "INTENT", "shop.buy", NOW)).ok


def _proposal(pid, uses=None, risk="low"):
    return {"id": pid, "summary": pid, "effects": [], "risk": risk, "undo": None, "expires": NOW,
            **({"uses": uses} if uses is not None else {})}


def test_lens_uses_attribute():
    def render(*ps):
        return lens({"yea": 1, "id": "s", "re": "c", "kind": "PROPOSALS", "proposals": list(ps)})

    one = render(_proposal("a", {"spend": spend("22.90", "USD"), "emails": quantity(1)}))
    assert "  uses: emails 1, spend 22.90 USD · risk: low · undo: never" in one
    assert "uses" not in render(_proposal("a"))
    # Shared when every proposal renders it the same; omitted when every proposal omits it.
    same = render(_proposal("a", {"emails": quantity(1)}), _proposal("b", {"emails": quantity(1)}))
    assert same.splitlines()[0].startswith("2 proposals — uses: emails 1 · risk: low")
    none = render(_proposal("a"), _proposal("b"))
    assert none.splitlines()[0].startswith("2 proposals — risk: low")
    # An omitted uses differs from a rendered one, so it isn't shared.
    mixed = render(_proposal("a", {"emails": quantity(1)}), _proposal("b"))
    assert "uses" not in mixed.splitlines()[0]
    assert "  uses: emails 1" in mixed and mixed.count("uses:") == 1


def _buy_service(uses):
    svc = Service("s", "S", trust=[ALICE.public])
    svc.intent("x.buy", "b")(lambda ctx: Plan("buy", [create("order/1")], lambda c: "ok", uses=uses))
    return svc


def _client(svc, *caveats):
    return Client(local(svc), key=AGENT, grants=[issue_grant(ALICE, AGENT.public, list(caveats))])


def test_service_puts_uses_on_proposals_and_receipts():
    async def go():
        c = _client(_buy_service({"spend": spend("6.00", "USD")}), {"can": ["x.*"]})
        p = (await c.intent("x.buy")).proposals[0]
        assert p["uses"] == {"spend": {"amount": 600, "scale": 2, "unit": "USD"}}
        assert (await c.commit(p)).receipt["uses"] == p["uses"]
        for empty in (None, {}):
            c = _client(_buy_service(empty), {"can": ["x.*"]})
            p = (await c.intent("x.buy")).proposals[0]
            assert "uses" not in p and "uses" not in (await c.commit(p)).receipt

    asyncio.run(go())


def test_service_rejects_malformed_uses_when_building():
    async def go():
        c = _client(_buy_service({"spend": {"amount": 1, "currency": "USD"}}), {"can": ["x.*"]})
        assert (await c.intent("x.buy")).code == "internal"

    asyncio.run(go())


def test_total_counts_emails_across_commits():
    async def go():
        svc = _buy_service({"emails": quantity(1)})
        c = _client(svc, {"total": {"of": "emails", "max": 2}})
        for _ in range(2):
            assert (await c.commit((await c.intent("x.buy")).proposals[0])).kind == "RECEIPT"
        assert (await c.commit((await c.intent("x.buy")).proposals[0])).code == "consent_required"

    asyncio.run(go())
