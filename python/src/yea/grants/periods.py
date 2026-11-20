"""Periods (SPEC §6.3): a ``total`` with ``every`` counts in fixed periods from the one ``nbf`` of
its block. Where a ``total`` counts (its ledger key), which period a time falls in, and when the
next one starts. Like ts/src/grants/periods.ts."""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Any, NamedTuple

from ..lens import fmt_duration, fmt_time, is_lens_time
from ..uses import fmt_quantity, is_total
from .token import _safe_int


class Period(NamedTuple):
    """The period of a ``total`` with ``every`` that a COMMIT counts in: its length and its start."""

    every: int
    start: int


class LedgerKey(NamedTuple):
    """Where a ``total`` counts (SPEC §6.3): its block id and measure, and for one with ``every``,
    the period. A commit's period is worked out once, when its grant is checked, and carried here."""

    block: str
    of: str
    period: Period | None = None


class TotalLimit(NamedTuple):
    """A ``total`` caveat a COMMIT counts against: where it counts, and its exact ceiling (scale 18)."""

    key: LedgerKey
    max: int


def _values(caveats: Iterable[Any], name: str) -> list[Any]:
    return [c[name] for c in caveats if isinstance(c, dict) and name in c]


def anchor_of(block: Mapping[str, Any]) -> int | None:
    """A block's one ``nbf``, which its periodic totals count from; None with none, several, or a
    malformed one."""
    nbf = _values(block["p"]["caveats"], "nbf")
    return nbf[0] if len(nbf) == 1 and _safe_int(nbf[0]) else None


def end_of(blocks: Iterable[Mapping[str, Any]]) -> int | None:
    """The earliest ``exp`` in ``blocks``; for all of a grant's, when it and its last period end.
    None with none."""
    exps = [v for b in blocks for v in _values(b["p"]["caveats"], "exp") if _safe_int(v)]
    return min(exps) if exps else None


def period_at(anchor: int, every: int, t: int) -> Period | None:
    """The period of ``every`` seconds counted from ``anchor`` that ``t`` is in; None before it.
    Python's integers are exact, so ``t − anchor`` past 2^53 needs no care here."""
    if t < anchor:
        return None
    return Period(every, t - (t - anchor) % every)


def ledger_key(block: str, limit: Mapping[str, Any], anchor: int | None, t: int) -> LedgerKey | None:
    """Where a COMMIT at ``t`` counts against ``limit``, a ``total`` of ``block`` whose periods count
    from ``anchor``. None before the anchor, where the block's own ``nbf`` denies the request and
    the total counts nothing."""
    every = limit.get("every")
    if every is None:
        return LedgerKey(block, limit["of"])
    period = None if anchor is None else period_at(anchor, every, t)
    return LedgerKey(block, limit["of"], period) if period else None


def total_keys(blocks: Iterable[Mapping[str, Any]], ids: Iterable[str], t: int) -> list[LedgerKey]:
    """The ledger keys a COMMIT at ``t`` reads: one for each well-formed ``total`` of each block."""
    out = []
    for b, bid in zip(blocks, ids, strict=True):
        for lim in _values(b["p"]["caveats"], "total"):
            key = ledger_key(bid, lim, anchor_of(b), t) if is_total(lim) else None
            if key:
                out.append(key)
    return out


def next_start(p: Period, end: int | None) -> int | None:
    """When the period after ``p`` starts, if that is before the grant ends at ``end`` and a time
    Lens can show (SPEC §9.2); otherwise None."""
    nxt = p.start + p.every
    return nxt if is_lens_time(nxt) and (end is None or nxt < end) else None


def starts_again(p: Period | None, end: int | None) -> str:
    """`` (starts again …)``, when the period after ``p`` starts before the grant ends; else nothing."""
    nxt = next_start(p, end) if p else None
    return "" if nxt is None else f" (starts again {fmt_time(nxt)})"


def fmt_limit(limit: Mapping[str, Any]) -> str:
    """A limit as Lens renders it (SPEC §9.2): ``500.00 USD``, or ``500.00 USD every 7d``."""
    shown = fmt_quantity({"amount": limit["max"], **{k: limit[k] for k in ("scale", "unit") if k in limit}})
    return f"{shown} every {fmt_duration(limit['every'])}" if "every" in limit else shown
