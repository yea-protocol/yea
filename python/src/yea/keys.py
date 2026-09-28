"""Ed25519 keys and proofs of possession (SPEC §6.1, §6.5)."""

from __future__ import annotations

import os
from dataclasses import dataclass

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

from ._json import b64url_decode, b64url_encode, canonical_bytes

KEY_PREFIX = "ed25519:"
PROOF_SKEW = 300  # seconds (SPEC §6.5)


@dataclass(frozen=True)
class KeyPair:
    """An Ed25519 key pair. ``seed`` is the 32-byte private key; ``public`` is ``ed25519:…``."""

    seed: bytes
    public: str

    @classmethod
    def generate(cls) -> KeyPair:
        return cls.from_seed(os.urandom(32))

    @classmethod
    def from_seed(cls, seed: bytes | str) -> KeyPair:
        raw = b64url_decode(seed) if isinstance(seed, str) else bytes(seed)
        if len(raw) != 32:
            raise ValueError("an Ed25519 seed is 32 bytes")
        pub = Ed25519PrivateKey.from_private_bytes(raw).public_key()
        return cls(raw, KEY_PREFIX + b64url_encode(pub.public_bytes(Encoding.Raw, PublicFormat.Raw)))

    def sign(self, message: bytes) -> str:
        """Sign bytes; returns the b64url signature."""
        return b64url_encode(Ed25519PrivateKey.from_private_bytes(self.seed).sign(message))

    def __repr__(self) -> str:  # never print the seed
        return f"KeyPair(public={self.public!r})"


def generate_key() -> KeyPair:
    return KeyPair.generate()


def key_from_seed(seed: bytes | str) -> KeyPair:
    return KeyPair.from_seed(seed)


def parse_public_key(key: str) -> Ed25519PublicKey:
    if not isinstance(key, str) or not key.startswith(KEY_PREFIX):
        raise ValueError("public keys look like ed25519:<b64url>")
    raw = b64url_decode(key[len(KEY_PREFIX):])
    if len(raw) != 32:
        raise ValueError("an Ed25519 public key is 32 bytes")
    return Ed25519PublicKey.from_public_bytes(raw)


def verify(public: str, message: bytes, sig: str) -> bool:
    """True iff ``sig`` is a valid signature of ``message`` by ``public``. Never raises."""
    try:
        raw_sig = b64url_decode(sig)
        if len(raw_sig) != 64:
            return False
        parse_public_key(public).verify(raw_sig, message)
        return True
    except (InvalidSignature, ValueError, TypeError):
        return False


def proof_message(aud: str, verb: str, target: str, ts: int) -> bytes:
    return canonical_bytes({"aud": aud, "verb": verb, "target": target, "ts": ts})


def sign_proof(key: KeyPair, aud: str, verb: str, target: str, ts: int) -> dict:
    """Build the ``proof`` object for a request (SPEC §6.5)."""
    return {"key": key.public, "ts": ts, "sig": key.sign(proof_message(aud, verb, target, ts))}


def verify_proof(proof: object, aud: str, verb: str, target: str, now: int) -> str | None:
    """Check a proof. Returns None if valid, else a one-sentence reason."""
    if not isinstance(proof, dict):
        return "missing or malformed proof"
    key, ts, sig = proof.get("key"), proof.get("ts"), proof.get("sig")
    if not isinstance(key, str) or not isinstance(sig, str) or type(ts) is not int:
        return "missing or malformed proof"
    if abs(now - ts) > PROOF_SKEW:
        return f"proof timestamp is outside the {PROOF_SKEW}s window"
    if not verify(key, proof_message(aud, verb, target, ts), sig):
        return "proof signature is invalid"
    return None
