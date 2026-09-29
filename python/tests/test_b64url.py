"""Canonical base64url (SPEC §6.1): one encoding per byte string, so a key, signature or grant
can't be re-encoded into a different string that still verifies."""

import base64

import pytest

from yea import issue_grant, key_from_seed, verify_grant
from yea._json import b64url_decode, b64url_encode, is_b64url
from yea.grants import Grant, GrantContext, decode_grant
from yea.keys import is_public_key, parse_public_key, verify

PRINCIPAL = key_from_seed(bytes([1]) * 32)
AGENT = key_from_seed(bytes([2]) * 32)
ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"


def same_bytes_other_string(s: str) -> str:
    """``s`` with its last character changed only in the bits a lenient decoder ignores."""
    def lenient(x):
        return base64.urlsafe_b64decode(x + "=" * (-len(x) % 4))

    return next(s[:-1] + c for c in ALPHABET if c != s[-1] and lenient(s[:-1] + c) == lenient(s))


@pytest.mark.parametrize("bad", [
    "AB",  # the last character's unused bits aren't zero
    "AA==",  # padding
    "a+b/",  # the standard alphabet
    "AA!!AA", "AA AA", "AA\nAA", "AAAA\n",  # characters outside the alphabet, and a trailing newline
    "AAAAA",  # length 1 mod 4
])
def test_non_canonical_base64url_is_refused(bad):
    with pytest.raises(ValueError):
        b64url_decode(bad)
    assert not is_b64url(bad)


def test_canonical_base64url_round_trips():
    for data in (b"", b"\x00", b"\x00\x01", b"\x00\x01\x02", bytes(range(256))):
        assert b64url_decode(b64url_encode(data)) == data


def test_a_grant_whose_signature_is_re_encoded_is_refused():
    """The block id is the hash of the ``s`` string: a second encoding of the same signature must
    not verify, or it would be a new block id with fresh total limits."""
    g = issue_grant(PRINCIPAL, AGENT.public, [{"total": {"of": "emails", "max": 1}}])
    blocks = [dict(b) for b in g.blocks]
    blocks[0]["s"] = same_bytes_other_string(blocks[0]["s"])
    with pytest.raises(ValueError, match="malformed block"):
        decode_grant(Grant(tuple(blocks)).encode())
    r = verify_grant(Grant(tuple(blocks)).encode(), [PRINCIPAL.public], AGENT.public,
                     GrantContext("s", "COMMIT", "x", 1_790_000_000, {"hash": "h", "risk": "low"}))
    assert not r.ok


def test_a_re_encoded_signature_or_key_does_not_verify():
    sig = PRINCIPAL.sign(b"m")
    assert verify(PRINCIPAL.public, b"m", sig)
    assert not verify(PRINCIPAL.public, b"m", same_bytes_other_string(sig))
    assert not verify(PRINCIPAL.public, b"m", sig[:5] + "!!!!" + sig[5:])
    key = PRINCIPAL.public
    odd = "ed25519:" + same_bytes_other_string(key[len("ed25519:"):])
    assert is_public_key(key) and not is_public_key(odd)
    with pytest.raises(ValueError):
        parse_public_key(odd)
    assert not verify(odd, b"m", sig)


def test_a_non_canonical_seed_is_refused():
    seed = PRINCIPAL.seed
    good = b64url_encode(seed)
    assert key_from_seed(good).public == PRINCIPAL.public
    with pytest.raises(ValueError):
        key_from_seed(same_bytes_other_string(good))
