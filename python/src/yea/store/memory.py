"""The in-memory store: for tests and single-process servers that keep nothing across restarts."""

from __future__ import annotations

import json
import time
from typing import Any

from .contract import (
    LedgerKey,
    Reservation,
    _key,
    _Ledger,
    _plan_hash,
    _receipt_id,
    _reservation_id,
    is_receipt_id,
)
from .file_store import CLAIM_STALE

PRUNE_AT = 1024  # MemoryStore drops expired consumed ids once it holds this many


class MemoryStore:
    """One process's store. Fine for a single-process server; totals reset on restart."""

    def __init__(self, now: Any = time.time):
        self._now = now
        self._consumed: dict[str, int] = {}
        self._receipts: dict[str, dict] = {}
        self._claimed: dict[str, float] = {}  # receipt id -> when it was claimed
        self._undone: set[str] = set()
        self._ledger: dict[LedgerKey, _Ledger] = {}
        self._consents: dict[str, str] = {}

    async def consume_once(self, id: str, expires_at: int) -> bool:
        if id in self._consumed:
            return False
        if len(self._consumed) >= PRUNE_AT:
            now = int(self._now())
            self._consumed = {k: e for k, e in self._consumed.items() if e > now}
        self._consumed[id] = expires_at
        return True

    async def put_receipt(self, r: dict) -> None:
        self._receipts[_receipt_id(r.get("id"))] = json.loads(json.dumps(r))

    async def get_receipt(self, id: str) -> dict | None:
        r = self._receipts.get(id) if is_receipt_id(id) else None
        return json.loads(json.dumps(r)) if r is not None else None

    async def claim_undo(self, id: str) -> bool:
        _receipt_id(id)
        now = self._now()
        if id in self._undone or (id in self._claimed and now - self._claimed[id] <= CLAIM_STALE):
            return False
        self._claimed[id] = now
        return True

    async def release_undo(self, id: str) -> None:
        self._claimed.pop(_receipt_id(id), None)

    async def mark_undone(self, id: str) -> None:
        self._undone.add(_receipt_id(id))
        self._claimed.pop(id, None)

    async def reserve(self, k: LedgerKey, amount: int, max: int) -> Reservation | None:
        led = self._ledger.setdefault(_key(k), _Ledger())
        if led.used + amount > max:
            return None
        r = Reservation(k, amount, _reservation_id())
        led.reserved[r.id] = amount
        return r

    async def settle(self, r: Reservation) -> None:
        led = self._ledger.get(r.key)
        if led is not None and r.id in led.reserved:
            led.settled += led.reserved.pop(r.id)

    async def release(self, r: Reservation) -> None:
        led = self._ledger.get(r.key)
        if led is not None:
            led.reserved.pop(r.id, None)

    async def used(self, k: LedgerKey) -> int:
        led = self._ledger.get(_key(k))
        return led.used if led else 0

    async def put_consent(self, plan_hash: str, grant: str) -> None:
        self._consents[_plan_hash(plan_hash)] = grant

    async def get_consent(self, plan_hash: str) -> str | None:
        return self._consents.get(_plan_hash(plan_hash))
