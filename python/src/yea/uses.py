"""What a commit uses up (SPEC §5.1 ``uses``) and the ``each``/``total`` limits on it (§6.3)."""

from __future__ import annotations

import copy
import re
from collections.abc import Mapping
from typing import Any

MAX_AMOUNT = 2**53 - 1
MAX_SCALE = 18
_NAME = re.compile(r"[a-z][a-z0-9_.\-]{0,63}")
_UNIT = re.compile(r"[A-Za-z0-9_./%\-]{1,32}")
_DECIMAL = re.compile(r"([0-9]+)(?:\.([0-9]+))?")


def is_name(v: Any) -> bool:
    """A measure name: 1–64 of ``a-z 0-9 _ . -``, starting with a letter."""
    return isinstance(v, str) and _NAME.fullmatch(v) is not None


def is_unit(v: Any) -> bool:
    return isinstance(v, str) and _UNIT.fullmatch(v) is not None


def _in_range(v: Any, top: int) -> bool:
    return type(v) is int and 0 <= v <= top


def is_quantity(q: Any) -> bool:
    """``{amount, scale?, unit?}`` with every field in range and nothing else."""
    if not isinstance(q, dict) or not set(q) <= {"amount", "scale", "unit"}:
        return False
    return _in_range(q.get("amount"), MAX_AMOUNT) and _scale_unit_ok(q)


def _scale_unit_ok(v: Mapping[str, Any]) -> bool:
    return ("scale" not in v or _in_range(v["scale"], MAX_SCALE)) and ("unit" not in v or is_unit(v["unit"]))


def is_uses(v: Any) -> bool:
    """A well-formed ``uses`` object. ``None`` (JSON ``null``) is not one: callers treat an
    absent key as "uses nothing" and a present one must pass this."""
    return isinstance(v, dict) and all(is_name(k) and is_quantity(q) for k, q in v.items())


def is_limit(v: Any) -> bool:
    """An ``each``/``total`` argument: ``{of, max, scale?, unit?}``."""
    if not isinstance(v, dict) or not set(v) <= {"of", "max", "scale", "unit"}:
        return False
    return is_name(v.get("of")) and _in_range(v.get("max"), MAX_AMOUNT) and _scale_unit_ok(v)


def check_uses(v: Any) -> dict | None:
    """Validate a plan's ``uses`` when the service builds it. Returns what goes on the wire:
    None for absent or empty. Raises ValueError, since a malformed one is the author's bug."""
    if v is None or v == {}:
        return None
    if not is_uses(v):
        raise ValueError(f"malformed uses {v!r}: names are a-z0-9_.- and quantities are {{amount, scale?, unit?}} in range")
    return copy.deepcopy(v)  # a plan mutating its dict later can't change what was hashed


def value(q: Mapping[str, Any]) -> int:
    """A quantity's exact value as an integer at scale 18, so any two compare and add exactly."""
    return q["amount"] * 10 ** (MAX_SCALE - q.get("scale", 0))


def limit_value(limit: Mapping[str, Any]) -> int:
    return limit["max"] * 10 ** (MAX_SCALE - limit.get("scale", 0))


def same_unit(q: Mapping[str, Any], limit: Mapping[str, Any]) -> bool:
    """Both have the same unit, or both have none. Units are never converted."""
    return q.get("unit") == limit.get("unit")


def quantity(amount: int, *, scale: int = 0, unit: str | None = None) -> dict:
    """A ``uses`` quantity worth ``amount × 10^-scale``, e.g. ``quantity(1)`` for one email."""
    q: dict[str, Any] = {"amount": amount}
    if scale:
        q["scale"] = scale
    if unit is not None:
        q["unit"] = unit
    if not is_quantity(q):
        raise ValueError(f"quantity out of range: {q!r}")
    return q


def spend(amount: str, currency: str) -> dict:
    """Money by the ``spend`` convention: ``spend("22.87", "USD")`` is 2287 at scale 2, in USD.
    The scale is the digits written, so write the currency's decimals (``"100.00"``)."""
    m = _DECIMAL.fullmatch(amount) if isinstance(amount, str) else None
    if m is None:
        raise ValueError(f"spend amount must be a plain decimal string like '22.87', not {amount!r}")
    whole, frac = m.group(1), m.group(2) or ""
    return quantity(int(whole + frac), scale=len(frac), unit=currency)


def fmt_quantity(q: Mapping[str, Any]) -> str:
    """Lens (§9.2): exactly ``scale`` decimals, then the unit if any. ``22.90 USD``, ``0.005``, ``1``.
    A malformed quantity renders as ``?``."""
    if not is_quantity(q):
        return "?"
    scale = q.get("scale", 0)
    digits = str(q["amount"]).rjust(scale + 1, "0")
    text = f"{digits[:-scale]}.{digits[-scale:]}" if scale else digits
    return f"{text} {q['unit']}" if "unit" in q else text


def fmt_uses(uses: Any) -> str | None:
    """``emails 1, spend 22.90 USD`` in canonical key order, None when empty, ``?`` when malformed."""
    if not isinstance(uses, dict):
        return "?"
    if not uses:
        return None
    return ", ".join(f"{name} {fmt_quantity(uses[name])}" for name in sorted(uses))
