"""How single fields read in a Lens: times, durations, effects, parameter lists and "more" lines (SPEC §9.2)."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from .lean import scalar

_EFFECT_SYM = {"create": "+", "update": "~", "delete": "-", "send": ">", "other": "*"}
_DURATION_UNITS = ((86400, "d"), (3600, "h"), (60, "m"))


def fmt_time(t: Any) -> str:
    if type(t) is not int and not (isinstance(t, float) and t.is_integer()):
        return scalar(t)
    d = datetime.fromtimestamp(int(t), tz=timezone.utc)
    s = d.strftime("%Y-%m-%dT%H:%M")
    return s + (f":{d.second:02d}" if d.second else "") + "Z"


def fmt_duration(secs: Any) -> str:
    if type(secs) is not int:
        return scalar(secs)
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

    return "(" + ", ".join(f"{k}: {ty(t)}" for k, t in params.items()) + ")"


def more_line(m: dict) -> str:
    return f"… {m.get('remaining')} more at {m.get('path')} — EXPAND {m.get('handle')} (~{m.get('est')} tokens)"
