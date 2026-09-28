"""The pg1 grant token: a chain of signed blocks, issued, delegated and decoded (SPEC §6.2)."""

from __future__ import annotations

import os
import time
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from .._json import b64url_decode, b64url_encode, canonical_bytes, loads, sha256_b64url
from ..keys import KeyPair

TOKEN_PREFIX = "pg1."


def block_id(block: Mapping[str, Any]) -> str:
    """``b64url(sha256(utf8(block.s)))``."""
    return sha256_b64url(block["s"].encode("utf-8"))


@dataclass(frozen=True)
class Grant:
    blocks: tuple[dict, ...]

    @property
    def id(self) -> str:
        return block_id(self.blocks[0])

    @property
    def block_ids(self) -> list[str]:
        return [block_id(b) for b in self.blocks]

    @property
    def principal(self) -> str:
        return self.blocks[0]["p"]["iss"]

    @property
    def holder(self) -> str:
        return self.blocks[-1]["p"]["sub"]

    def encode(self) -> str:
        return TOKEN_PREFIX + b64url_encode(canonical_bytes(list(self.blocks)))

    def delegate(self, holder: KeyPair, sub: str, caveats: list[dict], iat: int | None = None) -> Grant:
        """Append a block handing a narrower grant to ``sub``. ``holder`` must be the current holder."""
        if holder.public != self.holder:
            raise ValueError("only the grant's holder can delegate it")
        payload = {
            "prev": block_id(self.blocks[-1]),
            "sub": sub,
            "caveats": list(caveats),
            "iat": int(time.time()) if iat is None else iat,
        }
        return Grant(self.blocks + ({"p": payload, "s": holder.sign(canonical_bytes(payload))},))

    def __str__(self) -> str:
        return self.encode()


def issue_grant(
    issuer: KeyPair, sub: str, caveats: list[dict], iat: int | None = None, nonce: str | None = None
) -> Grant:
    """Issue a root grant from principal ``issuer`` to holder key ``sub``."""
    payload = {
        "iss": issuer.public,
        "sub": sub,
        "caveats": list(caveats),
        "iat": int(time.time()) if iat is None else iat,
        "nonce": b64url_encode(os.urandom(12)) if nonce is None else nonce,
    }
    return Grant(({"p": payload, "s": issuer.sign(canonical_bytes(payload))},))


def delegate_grant(grant: Grant | str, holder: KeyPair, sub: str, caveats: list[dict], iat: int | None = None) -> Grant:
    g = decode_grant(grant) if isinstance(grant, str) else grant
    return g.delegate(holder, sub, caveats, iat)


def _is_int(v: Any) -> bool:
    return type(v) is int


def _safe_int(v: Any) -> bool:
    return _is_int(v) and abs(v) <= 2**53 - 1


def decode_grant(token: str) -> Grant:
    """Decode and structurally validate a token. Does not check signatures. Raises ValueError."""
    if not isinstance(token, str) or not token.startswith(TOKEN_PREFIX):
        raise ValueError("not a pg1 grant")
    try:
        blocks = loads(b64url_decode(token[len(TOKEN_PREFIX):]).decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        raise ValueError("not valid b64url JSON") from None
    if not isinstance(blocks, list) or not blocks:
        raise ValueError("grant has no blocks")
    for i, b in enumerate(blocks):
        if not isinstance(b, dict) or not isinstance(b.get("p"), dict) or not isinstance(b.get("s"), str):
            raise ValueError("malformed block")
        p = b["p"]
        need = ("iss", "sub", "nonce") if i == 0 else ("prev", "sub")
        if not all(isinstance(p.get(k), str) for k in need):
            raise ValueError("malformed block")
        if not isinstance(p.get("caveats"), list) or not _is_int(p.get("iat")):
            raise ValueError("malformed block")
    return Grant(tuple(blocks))
