"""The usage ledger (GLOSSARY.md): the amount used against each ``total`` limit, settled and
reserved. It is held in process, with ApprovalStore's names and shapes, but synchronous, so a commit
checks and reserves in one step that no other commit can come between. Like
ts/src/service/commit-ledger/usage.ts."""

from __future__ import annotations

from collections.abc import Iterator, Mapping
from dataclasses import dataclass, field

from ...store import LedgerKey, Reservation
from ...uses import value
from .records import TotalLimit


@dataclass
class _Ledger:
    settled: int = 0
    reserved: dict[str, int] = field(default_factory=dict)


class UsageLedger(Mapping[LedgerKey, int]):
    """Settled plus reserved, by key: the ``used`` a grant's ``total`` limits are checked against."""

    def __init__(self) -> None:
        self._ledgers: dict[LedgerKey, _Ledger] = {}
        self._reservations = 0

    def __getitem__(self, key: LedgerKey) -> int:
        led = self._ledgers[LedgerKey(*key)]
        return led.settled + sum(led.reserved.values())

    def __iter__(self) -> Iterator[LedgerKey]:
        return iter(self._ledgers)

    def __len__(self) -> int:
        return len(self._ledgers)

    def reserve(self, key: LedgerKey, amount: int, max: int) -> Reservation | None:
        """Hold ``amount`` against ``key`` unless settled + reserved + amount would pass ``max``."""
        if self.get(key, 0) + amount > max:
            return None
        self._reservations += 1
        r = Reservation(key, amount, f"v{self._reservations}")
        self._ledgers.setdefault(key, _Ledger()).reserved[r.id] = amount
        return r

    def settle(self, r: Reservation) -> None:
        led = self._ledgers[r.key]
        if led.reserved.pop(r.id, None) is not None:
            led.settled += r.amount

    def release(self, r: Reservation) -> None:
        self._ledgers[r.key].reserved.pop(r.id, None)

    def reserve_all(self, proposal: dict, totals: list[TotalLimit]) -> list[Reservation] | TotalLimit:
        """Reserve the proposal's uses against every ``total`` it counts against, all or nothing: once
        per block and measure, under the smallest ``max`` when a block repeats a limit. Returns what
        it holds, or the limit one reservation would pass."""
        uses = proposal.get("uses") or {}
        held: list[Reservation] = []
        for t in _smallest_per_key(totals):
            q = uses.get(t.of)
            if q is None:
                continue
            r = self.reserve(LedgerKey(t.id, t.of), value(q), t.max)
            if r is None:
                for h in held:
                    self.release(h)
                return t
            held.append(r)
        return held


def _smallest_per_key(totals: list[TotalLimit]) -> list[TotalLimit]:
    """One limit per block and measure: the smallest, when a block repeats one."""
    out: dict[LedgerKey, TotalLimit] = {}
    for t in totals:
        key = LedgerKey(t.id, t.of)
        if key not in out or t.max < out[key].max:
            out[key] = t
    return list(out.values())
