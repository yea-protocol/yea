"""Light validation of params against the compact schema (SPEC §4.1.1), with teaching errors.

Mirrors ts/src/validate.ts so both implementations teach the same way.
"""

from __future__ import annotations

import re
from typing import Any

from ._json import compact, js_keys
from .errors import YeaError, fix

_DATE = re.compile(r"\d{4}-\d{2}-\d{2}")
_DATETIME = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})")


def distance(a: str, b: str) -> int:
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def closest(word: str, options: list[str]) -> str | None:
    if len(word) > 64:
        return None  # suggestions are for typos; don't pay O(n·m) for arbitrary input
    best, best_d = None, None
    for o in options:
        d = distance(word.lower(), o.lower())
        if best_d is None or d < best_d:
            best, best_d = o, d
    return best if best is not None and best_d <= max(2, len(word) // 3) else None


def _is_int(v: Any) -> bool:
    return (type(v) is int) or (isinstance(v, float) and v.is_integer())


def _check_type(type_: str, v: Any) -> str | None:
    base = type_.split(" — ")[0].strip()
    if base.endswith("[]"):
        inner = base[:-2]
        if not isinstance(v, list) or any(_check_type(inner, x) for x in v):
            return f"an array of {inner}"
        return None
    if base == "string":
        return None if isinstance(v, str) else "a string"
    if base == "int":
        return None if _is_int(v) and not isinstance(v, bool) else "an integer"
    if base == "number":
        return None if isinstance(v, (int, float)) and not isinstance(v, bool) else "a number"
    if base == "bool":
        return None if isinstance(v, bool) else "true or false"
    if base == "date":
        return None if isinstance(v, str) and _DATE.fullmatch(v) else "a date like 2026-09-24"
    if base == "datetime":
        return None if isinstance(v, str) and _DATETIME.fullmatch(v) else "an ISO datetime like 2026-09-24T15:00:00Z"
    if "|" in base:
        opts = base.split("|")
        return None if _js_string(v) in opts else f"one of {', '.join(opts)}"
    return None  # "any", or a type this implementation doesn't know


def _js_string(v: Any) -> str:
    if v is True:
        return "true"
    if v is False:
        return "false"
    if v is None:
        return "null"
    return v if isinstance(v, str) else compact(v)


def validate_params(schema: dict | None, params: dict, path: str = "") -> None:
    """Raise YeaError(invalid_params) with fixes if ``params`` don't match ``schema``."""
    if not schema:
        return
    problems: list[str] = []
    fixes: list[dict] = []
    order = js_keys(schema)  # TS walks both in Object.keys order, and the model reads the message
    names = [k[:-1] if k.endswith("?") else k for k in order]
    for raw in order:
        type_ = schema[raw]
        optional = raw.endswith("?")
        name = raw[:-1] if optional else raw
        v = params.get(name)
        if v is None:
            if not optional:
                problems.append(f"missing `{path}{name}` ({type_ if isinstance(type_, str) else 'object'})")
            continue
        if isinstance(type_, str):
            want = _check_type(type_, v)
            if want:
                problems.append(f"`{path}{name}` must be {want} (got {compact(v)})")
        elif isinstance(type_, list):
            if not isinstance(v, list):
                problems.append(f"`{path}{name}` must be an array of objects")
            else:
                for i, item in enumerate(v):
                    if not isinstance(item, dict):
                        problems.append(f"`{path}{name}.{i}` must be an object")
                        continue
                    try:
                        validate_params(type_[0], item, f"{path}{name}.{i}.")
                    except YeaError as e:
                        problems.append(e.message)
        elif not isinstance(v, dict):
            problems.append(f"`{path}{name}` must be an object")
        else:
            try:
                validate_params(type_, v, f"{path}{name}.")
            except YeaError as e:
                problems.append(e.message)
    for k in js_keys(params):
        if k in names:
            continue
        near = closest(k, names)
        problems.append(f"unknown param `{path}{k}`")
        if near and params.get(near) is None:
            fixes.append(fix(f"rename `{k}` to `{near}`", {k: None, near: params[k]}))
    if problems:
        raise YeaError("invalid_params", "; ".join(problems), fix=fixes or None)
