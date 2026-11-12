"""Caveats: which are well formed, and why one denies a request (SPEC §6.3)."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any

from .._json import compact
from ..risk import exceeds, is_risk
from ..uses import is_limit, is_total, is_uses, limit_value, same_unit, value
from .context import GrantContext
from .periods import fmt_limit, ledger_key, starts_again
from .token import _safe_int

RISK_ORDER = {"low": 0, "medium": 1, "high": 2}

# Caveats that, when they are the only ones failing a COMMIT, mean "ask the human" (§6.6).
CONSENT_CAVEATS = frozenset({"risk", "each", "total"})
LIMITS = frozenset({"each", "total"})
COMMIT_ONLY = frozenset({"each", "total", "risk", "only"})


def _matches(pattern: Any, name: str) -> bool:
    if not isinstance(pattern, str):
        return False
    if pattern.endswith("*"):
        return name.startswith(pattern[:-1])
    return pattern == name


@dataclass(frozen=True)
class Denial:
    """Why a caveat failed. ``hard`` means refuse (``forbidden``); otherwise ask (``consent_required``)."""

    why: str
    hard: bool


def limit_denial(name: str, limit: Mapping[str, Any], proposal: Mapping[str, Any], already: int = 0) -> Denial | None:
    """Why an ``each`` or ``total`` limit fails for a proposal, or None if it holds. A present
    but malformed ``uses`` (including null) is hard. ``already`` is the exact value committed
    or reserved against the total's ledger key (``total`` only)."""
    if name == "each":
        return _over_limit(limit, proposal, 0, lambda shown, _fits: f"over the per-commit limit of {shown}")
    return _over_limit(limit, proposal, already, lambda shown, _fits: f"would pass the total limit of {shown}")


def _over_limit(
    limit: Mapping[str, Any], proposal: Mapping[str, Any], already: int, breaks: Callable[[str, bool], str]
) -> Denial | None:
    """Why ``limit``, with ``already`` counted against it, fails for a proposal, in the words
    ``breaks`` gives for the limit as Lens shows it and whether the proposal alone fits it; or
    None if it holds. Like overLimit in ts/src/grants/limits.ts."""
    if "uses" not in proposal:
        return None
    uses = proposal["uses"]
    if not is_uses(uses):
        return Denial("malformed uses on the proposal", hard=True)
    of = limit["of"]
    q = uses.get(of)
    if q is None:
        return None  # limits bind only what is reported
    if not same_unit(q, limit):
        return Denial(f"{of} is in {q.get('unit') or 'no unit'}, but the limit is in {limit.get('unit') or 'no unit'}", hard=False)
    v, most = value(q), limit_value(limit)
    if already + v > most:
        return Denial(f"{of} {breaks(fmt_limit(limit), v <= most)}", hard=False)
    return None


def _str_list(v: Any) -> bool:
    return isinstance(v, list) and all(isinstance(x, str) for x in v)


_WELL_FORMED = {
    "svc": _str_list, "verbs": _str_list, "can": _str_list,
    "exp": _safe_int, "nbf": _safe_int,
    "each": is_limit, "total": is_total,
    "risk": lambda v: isinstance(v, str) and v in RISK_ORDER,
    "only": lambda v: isinstance(v, str),
}


def well_formed(caveat: Any) -> bool:
    """A known caveat name with a value of the right shape (SPEC §6.3)."""
    if not isinstance(caveat, dict) or len(caveat) != 1:
        return False
    (name, arg), = caveat.items()
    check = _WELL_FORMED.get(name)
    return check is not None and check(arg)


@dataclass(frozen=True)
class BlockFacts:
    """What a caveat needs from the rest of its grant (SPEC §6.3), None where there isn't one:
    ``anchor``, its block's one ``nbf``, which a periodic ``total`` counts from; ``bound``, the
    earliest ``exp`` in its block or an earlier one, which a periodic ``total`` needs (a later
    block's was written by its holder); ``end``, the grant's earliest ``exp`` in any block, when
    the grant and its last period end."""

    anchor: int | None = None
    bound: int | None = None
    end: int | None = None


def check_caveat(caveat: Any, bid: str, ctx: GrantContext, facts: BlockFacts = BlockFacts()) -> bool:
    """True iff one caveat is satisfied. Unknown or malformed caveats fail closed."""
    return caveat_denial(caveat, bid, ctx, facts) is None


def caveat_denial(caveat: Any, bid: str, ctx: GrantContext, facts: BlockFacts = BlockFacts()) -> Denial | None:
    """Why one caveat fails, or None when it is satisfied. Unknown or malformed caveats fail hard,
    as does a periodic ``total`` that ``facts`` give no anchor or no end, on every verb."""
    if not isinstance(caveat, dict) or len(caveat) != 1 or next(iter(caveat)) not in _WELL_FORMED:
        kind = "malformed" if not isinstance(caveat, dict) else "unknown"
        return Denial(f"{kind} caveat {compact(caveat)}", hard=True)
    if not well_formed(caveat):
        return Denial(f"malformed caveat {compact(caveat)}", hard=True)
    (name, arg), = caveat.items()
    if name == "total" and "every" in arg and (why := _unperiodic(facts)):
        return Denial(why, hard=True)
    if name in COMMIT_ONLY and ctx.verb != "COMMIT":
        return None  # known, and ignored outside COMMIT (§6.3)
    if name == "risk" and not is_risk((ctx.proposal or {}).get("risk")):
        return Denial("unknown risk on the proposal", hard=True)  # a ceiling can't judge it (§6.3)
    if name == "total":
        return _total_denial(arg, bid, ctx, facts)
    if name == "each":
        return limit_denial(name, arg, ctx.proposal or {})
    why = _denial(name, arg, ctx)
    return Denial(why, hard=name not in CONSENT_CAVEATS) if why else None


def _unperiodic(facts: BlockFacts) -> str | None:
    """Why a ``total`` with ``every`` can't count in periods in this grant (§6.3): its block hasn't
    exactly one ``nbf`` to count them from, or neither it nor an earlier block has an ``exp`` to
    end them."""
    if facts.anchor is None:
        return "a total with every needs exactly one nbf in its block"
    return "a total with every needs an exp in its block or an earlier one" if facts.bound is None else None


def _total_denial(limit: Mapping[str, Any], bid: str, ctx: GrantContext, facts: BlockFacts) -> Denial | None:
    """Why a well-formed ``total`` fails a COMMIT at ``ctx.now``, counted in its period if it has one."""
    key = ledger_key(bid, limit, facts.anchor, ctx.now)
    if key is None:
        return None  # before the block's nbf, which denies the request; this counts nothing
    again = starts_again(key.period, facts.end)
    # A proposal over the max alone fits no period, so the next one's start isn't offered.
    return _over_limit(
        limit, ctx.proposal or {}, int(ctx.used.get(key, 0)),
        lambda shown, fits: f"would pass the total limit of {shown}{again if fits else ''}",
    )


def _denial(name: str, arg: Any, ctx: GrantContext) -> str | None:
    """Why a well-formed, non-limit caveat denies the request, or None."""
    prop = ctx.proposal or {}
    if name == "svc":
        return None if ctx.service in arg else f"not valid for service {ctx.service}"
    if name == "verbs":
        return None if ctx.verb in arg else f"does not allow {ctx.verb}"
    if name == "can":
        ok = ctx.capability is not None and any(_matches(p, ctx.capability) for p in arg)
        return None if ok else f"does not cover {ctx.capability}"
    if name == "exp":
        return None if ctx.now < arg else "grant has expired"
    if name == "nbf":
        return None if ctx.now >= arg else "grant is not valid yet"
    if name == "risk":
        risk = prop.get("risk")
        return f"risk {risk} exceeds ceiling {arg}" if exceeds(risk, arg) else None
    if name == "only":
        return None if prop.get("hash") == arg else "grant is bound to a different proposal"
    return f"unknown caveat {compact({name: arg})}"
