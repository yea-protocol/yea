"""What every approval store offers, and the ids and keys it accepts (SPEC-approval §8)."""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from typing import Any, NamedTuple, Protocol

from .._json import b64url_encode

RECEIPT_ID = re.compile(r"r_[A-Za-z0-9_-]{8,32}")


_B64URL = re.compile(r"[A-Za-z0-9_-]{1,128}")


_MEASURE = re.compile(r"[a-z][a-z0-9_.\-]{0,63}")


class LedgerKey(NamedTuple):
    """A policy grant block id and a measure."""

    block: str
    of: str


@dataclass(frozen=True)
class Reservation:
    key: LedgerKey
    amount: int  # an exact value: an integer at scale 18
    id: str


class StoreError(Exception):
    """The store couldn't do what was asked. Callers fail closed."""


class ApprovalStore(Protocol):
    async def consume_once(self, id: str, expires_at: int) -> bool: ...
    async def put_receipt(self, r: dict) -> None: ...
    async def get_receipt(self, id: str) -> dict | None: ...
    async def claim_undo(self, id: str) -> bool: ...
    async def release_undo(self, id: str) -> None: ...
    async def mark_undone(self, id: str) -> None: ...
    async def reserve(self, k: LedgerKey, amount: int, max: int) -> Reservation | None: ...
    async def settle(self, r: Reservation) -> None: ...
    async def release(self, r: Reservation) -> None: ...
    async def used(self, k: LedgerKey) -> int: ...
    async def put_consent(self, plan_hash: str, grant: str) -> None: ...
    async def get_consent(self, plan_hash: str) -> str | None: ...


def is_receipt_id(v: Any) -> bool:
    """``r_`` and 8 to 32 characters of ``A-Z a-z 0-9 _ -`` (§7)."""
    return isinstance(v, str) and RECEIPT_ID.fullmatch(v) is not None


def _receipt_id(v: Any) -> str:
    if not is_receipt_id(v):
        raise StoreError(f"not a receipt id: {v!r}")
    return v


def _key(k: LedgerKey) -> LedgerKey:
    if not (isinstance(k.block, str) and _B64URL.fullmatch(k.block) and isinstance(k.of, str) and _MEASURE.fullmatch(k.of)):
        raise StoreError(f"bad ledger key {k!r}")
    return k


def _plan_hash(v: Any) -> str:
    if not (isinstance(v, str) and _B64URL.fullmatch(v)):
        raise StoreError(f"not a plan hash: {v!r}")
    return v


def _reservation_id() -> str:
    """``v_`` and 12 b64url characters (9 random bytes)."""
    return "v_" + b64url_encode(os.urandom(9))


@dataclass
class _Ledger:
    settled: int = 0
    reserved: dict[str, int] = field(default_factory=dict)

    @property
    def used(self) -> int:
        return self.settled + sum(self.reserved.values())
