import math

import pytest

from yea import CanonicalError, b64url_decode, b64url_encode, canonical, compact, proposal_hash
from yea._json import js_number


def test_canonical_sorts_and_strips_whitespace():
    assert canonical({"b": 1, "a": [True, None, "x"]}) == '{"a":[true,null,"x"],"b":1}'


def test_canonical_escapes_only_what_spec_says():
    assert canonical('q"\\\b\f\n\r\t\x01\x1f é ✓  ') == '"q\\"\\\\\\b\\f\\n\\r\\t\\u0001\\u001f é ✓  "'


@pytest.mark.parametrize("bad", [1.5, 2**53, -(2**53), float("nan"), {1: 2}, object()])
def test_canonical_rejects(bad):
    with pytest.raises(CanonicalError):
        canonical(bad)


def test_canonical_refuses_keys_that_are_the_same_once_pairs_are_joined():
    with pytest.raises(CanonicalError):
        canonical({"\ud83c\udf89": 1, "🎉": 2})
    assert canonical({"\ud83c\udf89": 1}) == '{"🎉":1}'


def test_canonical_accepts_integral_floats_like_js():
    assert canonical({"n": 3.0}) == '{"n":3}'


def test_b64url_roundtrip_unpadded():
    for n in range(8):
        data = bytes(range(250 - n, 250)) if n else b""
        s = b64url_encode(data)
        assert "=" not in s and b64url_decode(s) == data
    with pytest.raises(ValueError):
        b64url_decode("AA==")


@pytest.mark.parametrize(
    "x,js",
    [
        (0, "0"), (-0.0, "0"), (1.0, "1"), (1.5, "1.5"), (0.1, "0.1"), (-2.5, "-2.5"),
        (1e21, "1e+21"), (1e20, "100000000000000000000"), (123456789012345680000.0, "123456789012345680000"),
        (1e-6, "0.000001"), (1e-7, "1e-7"), (1.5e-7, "1.5e-7"), (0.00001, "0.00001"),
        (2.5e25, "2.5e+25"), (math.inf, "null"), (5e-324, "5e-324"), (1.7976931348623157e308, "1.7976931348623157e+308"),
    ],
)
def test_js_number(x, js):
    assert js_number(x) == js


def test_compact_keeps_insertion_order():
    assert compact({"b": 1.0, "a": [0.5]}) == '{"b":1,"a":[0.5]}'


def test_proposal_hash_ignores_hash_and_data():
    p = {"id": "p1", "risk": "low"}
    assert proposal_hash(p) == proposal_hash({**p, "hash": "whatever", "data": {"x": 1.5}})
