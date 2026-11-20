"""What caveats are checked against: the request, the proposal it commits, and what was already spent (SPEC §6.3)."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

from ..uses import value
from .periods import LedgerKey, Period


@dataclass
class GrantContext:
    """What a request asks for, evaluated against caveats."""

    service: str
    verb: str
    capability: str | None
    now: int
    proposal: Mapping[str, Any] | None = None  # {hash, uses?, risk}; COMMIT only
    # ledger key -> value committed or reserved, as an integer at scale 18
    used: Mapping[LedgerKey, int] = field(default_factory=dict)
    # False checks who may act only (ADR-0002): ``each``, ``total`` and ``risk`` are still checked
    # for shape, but never ask for consent.
    limits: bool = True

    def __post_init__(self) -> None:
        # A total looked up by LedgerKey never finds a (block, measure) pair, so a dict keyed that
        # way would count nothing: refuse it rather than let a total pass unfilled.
        if isinstance(self.used, dict) and not all(isinstance(k, LedgerKey) for k in self.used):
            raise TypeError("GrantContext.used is keyed by LedgerKey(block, of, period)")

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> GrantContext:
        return cls(d["service"], d["verb"], d.get("capability"), d["now"], d.get("proposal"), _used(d.get("used")))


def _used(d: Any) -> dict[LedgerKey, int]:
    """The JSON form, laid out as FileStore lays out the ledger, as exact values by ledger key:
    ``{block id: {measure: quantity, "measure@every": {start: quantity}}}``."""
    if not isinstance(d, dict):
        return {}
    return {k: v for bid, per in d.items() if isinstance(per, dict) for k, v in _used_in(bid, per).items()}


def _used_in(bid: str, per: dict) -> dict[LedgerKey, int]:
    out = {}
    for name, q in per.items():
        of, _, every = name.partition("@")
        if every:
            out.update({LedgerKey(bid, of, Period(int(every), int(start))): value(x) for start, x in q.items()})
        else:
            out[LedgerKey(bid, of)] = value(q)
    return out
