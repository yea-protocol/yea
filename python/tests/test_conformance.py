"""Shared conformance vectors (../conformance/*.json), generated from the TS implementation."""

import pytest
from conftest import CONFORMANCE, load_vectors

from yea import canonical, consent_code, decode_consent_code, decode_grant, est, fmt_quantity, key_from_seed, lens, lean, proposal_hash, sign_proof, verify_grant
from yea._json import CanonicalError
from yea.keys import verify_proof
from yea.text import printable
from yea.uses import is_uses


def vectors(name):
    data = load_vectors(name)
    if data is None:
        pytest.skip(f"{CONFORMANCE / name}.json not present")
    return data


def cases(name, key="name"):
    data = load_vectors(name)
    if data is None:
        return [pytest.param(None, marks=pytest.mark.skip(reason=f"{CONFORMANCE / name}.json missing"))]
    items = data["cases"] if isinstance(data, dict) else data
    return [pytest.param(c, id=str(c.get(key, i))) for i, c in enumerate(items)]


@pytest.mark.parametrize("case", cases("canonical"))
def test_canonical(case):
    if case.get("error"):  # a lone surrogate has no canonical form (SPEC §10)
        with pytest.raises(CanonicalError):
            canonical(case["input"])
        return
    assert canonical(case["input"]) == case["canonical"]


def test_canonical_joins_a_surrogate_pair_built_in_python():
    """Python can hold a pair as two code points (JSON parsing joins them); JS reads them as one
    character, so canonical does too, and only a lone one is refused (#160)."""
    assert canonical({"s": "\ud83c\udf89"}) == canonical({"s": "\U0001f389"}) == '{"s":"\U0001f389"}'


@pytest.mark.parametrize("case", cases("estimate", "text"))
def test_estimate(case):
    assert est(case["text"]) == case["est"]


@pytest.mark.parametrize("case", cases("printable", "text"))
def test_printable(case):
    """A consent screen escapes the same code points on both sides (security.test.ts [A8])."""
    assert printable(case["text"]) == case["printable"]


@pytest.mark.parametrize("case", cases("hash"))
def test_hash(case):
    assert proposal_hash(case["proposal"]) == case["hash"]


@pytest.mark.parametrize("case", cases("keys", "seed"))
def test_keys(case):
    if case.get("valid") is False:  # a seed that isn't canonical base64url (SPEC §6.1)
        with pytest.raises(ValueError):
            key_from_seed(case["seed"])
        return
    assert key_from_seed(case["seed"]).public == case["public"]


@pytest.mark.parametrize("case", cases("proof", "verb"))
def test_proof(case):
    if case.get("valid") is False:  # a non-canonical signature or key never verifies
        proof = {"key": case["key"], "ts": case["ts"], "sig": case["sig"]}
        assert verify_proof(proof, case["aud"], case["verb"], case["target"], case["ts"]) is not None
        return
    k = key_from_seed(case["seed"])
    if "key" in case:
        assert k.public == case["key"]
    assert sign_proof(k, case["aud"], case["verb"], case["target"], case["ts"])["sig"] == case["sig"]
    proof = {"key": k.public, "ts": case["ts"], "sig": case["sig"]}
    assert verify_proof(proof, case["aud"], case["verb"], case["target"], case["ts"]) is None
    assert verify_proof(proof, case["aud"], case["verb"], "other", case["ts"]) is not None  # a wrong target fails


@pytest.mark.parametrize("case", cases("grants"))
def test_grants(case):
    r = verify_grant(case["token"], case["trusted"], case["proofKey"], case["ctx"])
    assert r.ok == case["expect"]["ok"], r.message
    assert r.code == case["expect"].get("code")


def test_grants_total_block_ids():
    data = vectors("grants")
    ids = {bid for c in data["cases"] for bid in _block_ids(c["token"])}
    assert data["rootTotalBlockId"] in ids and data["countsTotalBlockId"] in ids


def test_grants_seeds_name_the_trusted_principal():
    data = vectors("grants")
    assert key_from_seed(data["seeds"]["principal"]).public in data["cases"][0]["trusted"]


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
    data = load_vectors("uses")
    if data is None:
        return [pytest.param(None, marks=pytest.mark.skip(reason=f"{CONFORMANCE}/uses.json missing"))]
    items = data[key]
    return [pytest.param(c, id=c.get("name") or c.get("lens")) for c in items]


@pytest.mark.parametrize("case", _uses_cases("quantities"))
def test_uses_quantity_lens(case):
    assert fmt_quantity(case["quantity"]) == case["lens"]


@pytest.mark.parametrize("case", _uses_cases("wellFormed"))
def test_uses_well_formed(case):
    assert is_uses(case["uses"]) is case["valid"]
