"""An unknown plan risk fails closed everywhere (#96, parity with TS #95)."""

import asyncio

import pytest

from yea import Client, GrantContext, Plan, Service, create, issue_grant, key_from_seed, local, verify_grant
from yea.approval import Policy, at_least, plan_hash
from yea.client import Reply
from yea.client.reply import _checked_reply
from yea.risk import exceeds, known_risk, resolve_risk

ALICE = key_from_seed(bytes(32))
AGENT = key_from_seed(bytes([1]) * 32)
NOW = 1_790_000_000


def test_comparisons_fail_closed():
    assert at_least("critical", "high") and at_least("low", "bogus") and not at_least("low", "medium")
    assert exceeds("critical", "high") and exceeds("low", "bogus") and not exceeds("medium", "high")


def test_resolve_and_known():
    assert resolve_risk("medium", None, "low") == "low" and resolve_risk("medium", None, None) == "medium"
    for bad in ("critical", "", 3, "HIGH"):
        with pytest.raises(ValueError, match="unknown risk"):
            resolve_risk("low", bad)
    with pytest.raises(ValueError, match="unknown risk"):
        known_risk(None)


def test_an_unknown_risk_never_gets_a_plan_hash():
    with pytest.raises(ValueError, match="unknown risk"):
        plan_hash("t", {}, Plan("x", [], lambda: None), "critical")


def test_a_risk_caveat_against_an_unknown_risk_is_forbidden():
    g = issue_grant(ALICE, AGENT.public, [{"risk": "high"}], iat=NOW)
    ctx = GrantContext("svc", "COMMIT", "shop.buy", NOW, {"hash": "H", "risk": "critical"})
    r = verify_grant(g, [ALICE.public], AGENT.public, ctx)
    assert r.code == "forbidden" and "unknown risk on the proposal" in r.reason


def test_the_service_refuses_to_propose_an_unknown_risk():
    svc = Service("s", "S")
    svc.intent("x.do", "d")(lambda ctx: Plan("do", [create("x/1")], lambda c: None, risk="critical"))

    async def go():
        return await Client(local(svc)).intent("x.do")

    assert asyncio.run(go()).code == "internal"


def test_the_client_rejects_a_proposal_with_an_unknown_risk():
    frame = {"yea": 1, "id": "s", "re": "c", "kind": "PROPOSALS",
             "proposals": [{"id": "p_1", "summary": "s", "effects": [], "risk": "critical", "undo": None, "expires": NOW}]}
    r = _checked_reply(Reply(frame))
    assert r.kind == "ERROR" and r.code == "bad_frame"
    assert r.message == "proposal p_1 from the service has an unknown risk, so it was ignored"


def test_decide_sends_an_unknown_risk_out_of_band():
    from yea.approval import HashedPlan, decide

    hp = HashedPlan("t", Plan("x", [], lambda: None), "h", "critical", True)
    assert decide([hp], Policy(out_of_band="high"), lambda k: 0, NOW).kind == "out-of-band"


def test_check_consent_refuses_an_unknown_risk():
    from yea import check_consent, proposal_hash

    p = {"id": "p1", "capability": "x.do", "summary": "s", "effects": [], "risk": "critical", "undo": None,
         "expires": NOW + 60}
    p["hash"] = proposal_hash(p)
    consent = {"proposal": "p1", "hash": p["hash"], "service": "svc", "capability": "x.do"}
    with pytest.raises(ValueError, match="unknown risk"):
        check_consent(consent, p, "svc")
