"""Lens formatting helpers (SPEC §9.2): times, durations, effect lines, parameter lists and "more" lines."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from .._json import js_keys
from .notation import scalar

_EFFECT_SYM = {"create": "+", "update": "~", "delete": "-", "send": ">", "other": "*"}
_DURATION_UNITS = ((86400, "d"), (3600, "h"), (60, "m"))


MAX_TIME = 253402300799  # 9999-12-31T23:59:59Z
MAX_SAFE = 2**53 - 1


def _whole(v: Any, lo: int, hi: int) -> int | None:
    """``v`` as an int when it's a whole number (an integer-valued float counts, as in JS) in
    [lo, hi]; else None. Booleans don't count."""
    if type(v) is float and v.is_integer():
        v = int(v)
    return v if type(v) is int and lo <= v <= hi else None


def fmt_time(t: Any) -> str:
    """An ISO time; anything that isn't a whole number of seconds in [0, 9999-12-31] renders as its
    lean scalar (§9.2 malformed values)."""
    secs = _whole(t, 0, MAX_TIME)
    if secs is None:
        return scalar(t)
    d = datetime.fromtimestamp(secs, tz=timezone.utc)
    s = d.strftime("%Y-%m-%dT%H:%M")
    return s + (f":{d.second:02d}" if d.second else "") + "Z"


def fmt_duration(v: Any) -> str:
    """``1h``, ``90s``; anything that isn't a whole number within ±(2^53−1) renders as its lean
    scalar (§9.2 malformed values)."""
    secs = _whole(v, -MAX_SAFE, MAX_SAFE)
    if secs is None:
        return scalar(v)
    for size, unit in _DURATION_UNITS:
        if secs != 0 and secs % size == 0:
            return f"{secs // size}{unit}"
    return f"{secs}s"


def effect_line(e: dict) -> str:
    op = e.get("op", "other")
    line = f"{_EFFECT_SYM.get(op, '*')} {op} {e.get('target', '')}"
    if e.get("field"):
        line += f".{e['field']}"
    if "from" in e or "to" in e:
        line += f": {scalar(e.get('from'))} → {scalar(e.get('to'))}"
    if e.get("detail"):
        line += f" — {e['detail']}"
    return line


def param_list(params: Any) -> str:
    """``(name: type, …)``; nested schemas render as ``{k: t}``, arrays of them as ``[{…}]``."""
    if not params:
        return "()"

    def ty(t: Any) -> str:
        if isinstance(t, str):
            return t
        if isinstance(t, list):
            return f"[{ty(t[0])}]"
        return "{" + param_list(t)[1:-1] + "}"

    return "(" + ", ".join(f"{k}: {ty(params[k])}" for k in js_keys(params)) + ")"


def more_line(m: dict) -> str:
    return f"… {m.get('remaining')} more at {m.get('path')} — EXPAND {m.get('handle')} (~{m.get('est')} tokens)"
