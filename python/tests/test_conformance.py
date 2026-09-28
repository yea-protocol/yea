"""Shared conformance vectors (../conformance/*.json), generated from the TS implementation."""

import json

import pytest
from conftest import CONFORMANCE

from yea import canonical, consent_code, decode_consent_code, decode_grant, est, fmt_quantity, key_from_seed, lens, lean, proposal_hash, sign_proof, verify_grant
from yea.uses import is_uses


def vectors(name):
    path = CONFORMANCE / f"{name}.json"
    if not path.exists():
        pytest.skip(f"{path} not present")
    return json.loads(path.read_text(encoding="utf-8"))


def cases(name, key="name"):
    path = CONFORMANCE / f"{name}.json"
    if not path.exists():
        return [pytest.param(None, marks=pytest.mark.skip(reason=f"{path} missing"))]
    data = json.loads(path.read_text(encoding="utf-8"))
    items = data["cases"] if isinstance(data, dict) else data
    return [pytest.param(c, id=str(c.get(key, i))) for i, c in enumerate(items)]


@pytest.mark.parametrize("case", cases("canonical"))
def test_canonical(case):
    assert canonical(case["input"]) == case["canonical"]


@pytest.mark.parametrize("case", cases("estimate", "text"))
def test_estimate(case):
    assert est(case["text"]) == case["est"]


@pytest.mark.parametrize("case", cases("hash"))
def test_hash(case):
    assert proposal_hash(case["proposal"]) == case["hash"]


@pytest.mark.parametrize("case", cases("keys", "seed"))
def test_keys(case):
    assert key_from_seed(case["seed"]).public == case["public"]


@pytest.mark.parametrize("case", cases("proof", "verb"))
def test_proof(case):
    k = key_from_seed(case["seed"])
    if "key" in case:
        assert k.public == case["key"]
    assert sign_proof(k, case["aud"], case["verb"], case["target"], case["ts"])["sig"] == case["sig"]


@pytest.mark.parametrize("case", cases("grants"))
def test_grants(case):
    r = verify_grant(case["token"], case["trusted"], case["proofKey"], case["ctx"])
    assert r.ok == case["expect"]["ok"], r.message
    assert r.code == case["expect"].get("code")


def test_grants_total_block_ids():
    data = vectors("grants")
    ids = {bid for c in data["cases"] for bid in _block_ids(c["token"])}
    assert data["rootTotalBlockId"] in ids and data["countsTotalBlockId"] in ids


def test_protocol_consent_code():
    v = vectors("grants")["consentCode"]
    code = consent_code(v["consent"], v["detail"], agent=v["agent"])
    assert code == v["code"]
    assert decode_consent_code(code)["agent"] == v["agent"]


def _block_ids(token):
    try:
        return decode_grant(token).block_ids
    except ValueError:
        return []


@pytest.mark.parametrize("case", cases("lens"))
def test_lens(case):
    out = lean(case["input"]) if case["type"] == "value" else lens(case["input"])
    assert out == case["lens"]


def _uses_cases(key):
    path = CONFORMANCE / "uses.json"
    if not path.exists():
        return [pytest.param(None, marks=pytest.mark.skip(reason=f"{path} missing"))]
    items = json.loads(path.read_text(encoding="utf-8"))[key]
    return [pytest.param(c, id=c.get("name") or c.get("lens")) for c in items]


@pytest.mark.parametrize("case", _uses_cases("quantities"))
def test_uses_quantity_lens(case):
    assert fmt_quantity(case["quantity"]) == case["lens"]


@pytest.mark.parametrize("case", _uses_cases("wellFormed"))
def test_uses_well_formed(case):
    assert is_uses(case["uses"]) is case["valid"]
