"""An approver's checks and display before consenting (#87, mirrors ts/src/approve.ts)."""

import pytest

from yea import check_consent, check_proposal, consent_from, consent_lines, consent_view, proposal_hash

NOW = 1_790_000_000


def proposal(**over):
    p = {"id": "p1", "capability": "x.do", "summary": "Do it", "effects": [{"op": "update", "target": "t", "from": 1, "to": 2}],
         "risk": "low", "undo": {"window": 60}, "expires": NOW + 60, **over}
    p["hash"] = proposal_hash(p)
    return p


def request(p, **over):
    return {"proposal": p["id"], "hash": p["hash"], "service": "svc", "capability": p["capability"],
            "principal": "ed25519:x", "summary": p["summary"], "expires": NOW + 600, **over}


def test_check_proposal():
    assert check_proposal(proposal()) is None
    assert check_proposal(proposal(uses={"spend": {"amount": -1}})) == "the proposal has a malformed uses"
    assert check_proposal(proposal(risk="critical")) == "the proposal has an unknown risk"
    assert check_proposal({**proposal(), "summary": "changed"}) == "the proposal doesn't match its hash"
    assert check_proposal({**proposal(), "data": {"x": 1.5}}) is None  # data isn't hashed
    assert check_proposal({**proposal(), "summary": 1.5}) == "the proposal doesn't match its hash"  # unhashable


@pytest.mark.parametrize("over,why", [
    ({"proposal": "p2"}, "the consent request names another proposal"),
    ({"hash": "h"}, "the consent request's hash isn't the proposal's"),
    ({"capability": "y"}, "the consent request names another capability"),
    ({"service": "other"}, "the consent request names another service"),
])
def test_check_consent_names_the_first_problem(over, why):
    p = proposal()
    with pytest.raises(ValueError, match=why):
        check_consent(request(p, **over), p, "svc")


def test_check_consent_refuses_a_malformed_uses():
    p = proposal(uses={"spend": {"amount": 1, "extra": 1}})
    with pytest.raises(ValueError, match="malformed uses"):
        check_consent(request(p), p, "svc")


def test_consent_view_is_the_proposal_escaped_line_by_line():
    p = proposal(summary="Pay\n+ create admin‮", data={"secret": "not shown"})
    lines = consent_view(p)
    assert lines[0].startswith("[p1] Pay\\u{a}+ create admin\\u{202e}")
    assert not any(line.startswith("+ create admin") for line in lines) and "not shown" not in "\n".join(lines)
    out = consent_lines(request(p), p, "svc")
    assert out["lines"][0] == "at svc:" and out["lines"][1:] == lines
    assert consent_lines(request(p, hash="h"), p, "svc") == {"why": "the consent request's hash isn't the proposal's"}


def test_consent_from_builds_from_the_proposal():
    p = proposal()
    k = request(p, summary="a different summary", expires=NOW + 5)
    c = consent_from(k, p)
    assert c["summary"] == "Do it" and c["expires"] == NOW + 5 and c["service"] == "svc" and c["principal"] == "ed25519:x"
