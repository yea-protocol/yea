"""Lean notation (SPEC §9.1): any JSON value as compact, indented text, with scalars bare where that's
unambiguous and quoted otherwise."""

from __future__ import annotations

import math
import re
from typing import Any

from .._json import compact, js_keys, js_number, quote
from .depth import clip_depth

_BARE = re.compile(r"[A-Za-z0-9_@./+\-:() '!?&%$#*=<>~^]+")
_JSON_NUMBER = re.compile(r"-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?")
_RESERVED = frozenset({"-", "true", "false", "null"})


def _is_scalar(v: Any) -> bool:
    return v is None or isinstance(v, (bool, int, float, str))


def _is_bare(s: str) -> bool:
    return (
        _BARE.fullmatch(s) is not None
        and not s.startswith(" ")
        and not s.endswith(" ")
        and s not in _RESERVED
        and _JSON_NUMBER.fullmatch(s) is None
    )


def scalar(v: Any) -> str:
    if v is None:
        return "-"
    if v is True:
        return "true"
    if v is False:
        return "false"
    if isinstance(v, (int, float)):
        return "-" if isinstance(v, float) and not math.isfinite(v) else js_number(v)
    if isinstance(v, str):
        return v if _is_bare(v) else quote(v)
    return compact(clip_depth(v))  # not a scalar (a malformed time, say): its compact JSON


def _ind(n: int) -> str:
    return "  " * n


def _object_lines(obj: dict, n: int) -> list[str]:
    lines: list[str] = []
    for k in js_keys(obj):
        lines.extend(_entry_lines(str(k), obj[k], n))
    return lines


def _entry_lines(key: str, v: Any, n: int) -> list[str]:
    key = scalar(key)
    if isinstance(v, dict):
        if not v:
            return [f"{_ind(n)}{key}: {{}}"]
        return [f"{_ind(n)}{key}:"] + _object_lines(v, n + 1)
    if isinstance(v, (list, tuple)):
        return _array_lines(key, list(v), n)
    return [f"{_ind(n)}{key}: {scalar(v)}"]


# _array_lines and _item_lines take an already-rendered key.


def _scalar_list(items: list) -> str:
    return "[" + ", ".join(scalar(x) for x in items) + "]"


def _is_table(items: list) -> bool:
    first = items[0]
    if not isinstance(first, dict) or not first:
        return False
    keys = js_keys(first)
    return all(
        isinstance(x, dict) and js_keys(x) == keys and all(_is_scalar(val) for val in x.values()) for x in items
    )


def _array_lines(key: str, items: list, n: int) -> list[str]:
    if not items:
        return [f"{_ind(n)}{key}: []"]
    if all(_is_scalar(x) for x in items):
        return [f"{_ind(n)}{key}: {_scalar_list(items)}"]
    if _is_table(items):
        keys = js_keys(items[0])
        head = f"{_ind(n)}{key}[{len(items)}]{{{','.join(scalar(k) for k in keys)}}}:"
        rows = [_ind(n + 1) + ",".join(scalar(x[k]) for k in keys) for x in items]
        return [head] + rows
    lines = [f"{_ind(n)}{key}[{len(items)}]:"]
    for el in items:
        lines.extend(_item_lines(el, n + 1))
    return lines


def _item_lines(el: Any, n: int) -> list[str]:
    dash = _ind(n) + "- "
    if isinstance(el, dict):
        if not el:
            return [dash + "{}"]
        sub = _object_lines(el, n + 1)
        sub[0] = dash + sub[0][len(_ind(n + 1)):]
        return sub
    if isinstance(el, (list, tuple)):
        el = list(el)
        return [dash + (_scalar_list(el) if all(_is_scalar(x) for x in el) else compact(el))]
    return [dash + scalar(el)]


def lean(value: Any) -> str:
    """Lean rendering of an arbitrary JSON value, clipped to ``MAX_DEPTH``."""
    v = clip_depth(value)
    if isinstance(v, dict):
        return "\n".join(_object_lines(v, 0)) or "{}"
    if isinstance(v, (list, tuple)):
        return "\n".join(_array_lines("items", list(v), 0))
    return scalar(v)
