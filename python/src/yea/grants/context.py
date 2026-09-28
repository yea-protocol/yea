"""What caveats are checked against: the request, the proposal it commits, and what was already spent (SPEC §6.3)."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

from ..uses import value


@dataclass
class GrantContext:
    """What a request asks for, evaluated against caveats."""

    service: str
    verb: str
    capability: str | None
    now: int
    proposal: Mapping[str, Any] | None = None  # {hash, uses?, risk}; COMMIT only
    # (block id, measure name) -> value committed or reserved, as an integer at scale 18
    used: Mapping[tuple[str, str], int] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> GrantContext:
        return cls(d["service"], d["verb"], d.get("capability"), d["now"], d.get("proposal"), _used(d.get("used")))


def _used(d: Any) -> dict[tuple[str, str], int]:
    """``{block id: {measure: quantity}}`` (the JSON form) as exact values keyed by (block id, measure)."""
    if not isinstance(d, dict):
        return {}
    return {(bid, of): value(q) for bid, per in d.items() if isinstance(per, dict) for of, q in per.items()}
