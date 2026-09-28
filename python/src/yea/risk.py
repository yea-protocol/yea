"""Risk levels (SPEC §5.1), lowest first: one order for grants, policy and approval. Any other
value is malformed, and every comparison here fails closed on one. Mirrors ts/src/risk.ts."""

from __future__ import annotations

from typing import Any

RISKS = ("low", "medium", "high")


def is_risk(v: Any) -> bool:
    return isinstance(v, str) and v in RISKS


def _rank(r: Any) -> int:
    """A risk's place in the order; an unknown one ranks above every known one."""
    return RISKS.index(r) if is_risk(r) else len(RISKS)


def at_least(r: Any, floor: Any) -> bool:
    """Whether ``r`` is ``floor`` or riskier. Fails closed for a gate such as ``outOfBand``: an
    unknown ``r`` meets every floor, and an unknown ``floor`` is met by every risk."""
    return not is_risk(floor) or _rank(r) >= _rank(floor)


def exceeds(r: Any, ceiling: Any) -> bool:
    """Whether ``r`` is riskier than ``ceiling``, as a ``risk`` caveat checks it. Fails closed: an
    unknown ``r`` exceeds every ceiling, and an unknown ``ceiling`` is exceeded by every risk."""
    return not is_risk(ceiling) or _rank(r) > _rank(ceiling)


def known_risk(risk: Any) -> str:
    """``risk`` if it's a known risk; raises otherwise, so a plan with one never goes further."""
    if not is_risk(risk):
        raise ValueError(f"plan has an unknown risk: {risk!r}")
    return risk


def resolve_risk(fallback: str, *risks: Any) -> str:
    """The first of ``risks`` that is set (not None), else ``fallback``, and it must be known."""
    chosen = next((r for r in risks if r is not None), None)
    return fallback if chosen is None else known_risk(chosen)
