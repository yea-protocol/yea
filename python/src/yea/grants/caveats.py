"""Caveats: which are well formed, and why one denies a request (SPEC §6.3)."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from .._json import compact
from ..risk import exceeds, is_risk
from ..uses import fmt_quantity, is_limit, is_uses, limit_value, same_unit, value
from .context import GrantContext
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
    or reserved under the block (``total`` only)."""
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
    shown = fmt_quantity({"amount": limit["max"], **{k: limit[k] for k in ("scale", "unit") if k in limit}})
    if name == "each" and value(q) > limit_value(limit):
        return Denial(f"{of} over the per-commit limit of {shown}", hard=False)
    if name == "total" and already + value(q) > limit_value(limit):
        return Denial(f"{of} would pass the total limit of {shown}", hard=False)
    return None


def _str_list(v: Any) -> bool:
    return isinstance(v, list) and all(isinstance(x, str) for x in v)


_WELL_FORMED = {
    "svc": _str_list, "verbs": _str_list, "can": _str_list,
    "exp": _safe_int, "nbf": _safe_int,
    "each": is_limit, "total": is_limit,
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


def check_caveat(caveat: Any, bid: str, ctx: GrantContext) -> bool:
    """True iff one caveat is satisfied. Unknown or malformed caveats fail closed."""
    return caveat_denial(caveat, bid, ctx) is None


def caveat_denial(caveat: Any, bid: str, ctx: GrantContext) -> Denial | None:
    """Why one caveat fails, or None when it is satisfied. Unknown or malformed caveats fail hard."""
    if not isinstance(caveat, dict) or len(caveat) != 1 or next(iter(caveat)) not in _WELL_FORMED:
        kind = "malformed" if not isinstance(caveat, dict) else "unknown"
        return Denial(f"{kind} caveat {compact(caveat)}", hard=True)
    if not well_formed(caveat):
        return Denial(f"malformed caveat {compact(caveat)}", hard=True)
    (name, arg), = caveat.items()
    if name in COMMIT_ONLY and ctx.verb != "COMMIT":
        return None  # known, and ignored outside COMMIT (§6.3)
    if name == "risk" and not is_risk((ctx.proposal or {}).get("risk")):
        return Denial("unknown risk on the proposal", hard=True)  # a ceiling can't judge it (§6.3)
    if name in LIMITS:
        return limit_denial(name, arg, ctx.proposal or {}, int(ctx.used.get((bid, arg["of"]), 0)))
    why = _denial(name, arg, ctx)
    return Denial(why, hard=name not in CONSENT_CAVEATS) if why else None


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
