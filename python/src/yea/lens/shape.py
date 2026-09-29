"""Which frames of a known kind Lens renders as that kind (SPEC §9.2, well-formed frames): each listed
member has its type. Anything else renders as an unknown kind, so a missing or wrong-typed member can't make
rendering fail. Mirrors ts/src/lens/shape.ts."""

from __future__ import annotations

from typing import Any

# A member's type: a JSON type by name, a one-element list for an array of it, or a dict of an
# object's members. A member named ``k?`` may be absent or null.
_EFFECT = {"op": "string", "target": "string", "field?": "string", "detail?": "string", "from?": "scalar", "to?": "scalar"}

_KINDS: dict[str, Any] = {
    "BRIEF": {
        "service": {"id": "string", "name": "string", "summary?": "string"},
        "capabilities": [{"kind": "string", "name": "string", "summary?": "string", "risk?": "string", "params?": "params"}],
    },
    "ANSWER": {"data": "any"},
    "PROPOSALS": {"proposals": [{"id": "string", "summary": "string", "effects": [_EFFECT]}]},
    "CLARIFY": {"question": "string", "options": [{"label": "string"}]},
    "RECEIPT": {
        "receipt": {"id": "string", "summary": "string", "undoes?": "string", "effects?": [_EFFECT]},
        "replay?": "boolean",
        "auto?": "boolean",
    },
    "ERROR": {
        "code": "string",
        "message": "string",
        "fix?": [{"say": "string", "params?": {}}],
        "need?": ["any"],
        "consent?": {"hash": "string", "summary": "string"},
    },
    "EVENT": {"message": "string"},
}

_MORE = [{"remaining": "integer", "path": "string", "handle": "string", "est": "integer"}]

_MAX_SAFE = 2**53 - 1
# So checking and rendering a param schema can't overflow the stack. Keep it well under depth.py's
# MAX_DEPTH, which a schema must never reach.
_MAX_PARAM_DEPTH = 32
_ABSENT = object()


def is_safe_integer(v: Any) -> bool:
    """As ``Number.isSafeInteger``: 3.0 counts, since JSON can't tell it from 3."""
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return False
    return float(v).is_integer() and abs(v) <= _MAX_SAFE if isinstance(v, float) else abs(v) <= _MAX_SAFE


def _is_params(v: Any, depth: int = 0) -> bool:
    """A param schema: every value a type name, a nested schema, or a one-element array of either,
    nested at most _MAX_PARAM_DEPTH deep."""
    def is_type(t: Any) -> bool:
        if isinstance(t, str):
            return True
        if depth >= _MAX_PARAM_DEPTH:
            return False
        if isinstance(t, (list, tuple)):
            return len(t) == 1 and _is_params({"t": t[0]}, depth + 1)
        return _is_params(t, depth + 1)

    return isinstance(v, dict) and all(is_type(t) for t in v.values())


def _fits(v: Any, s: Any) -> bool:
    if s == "any":
        return v is not _ABSENT
    if s == "string":
        return isinstance(v, str)
    if s == "boolean":
        return isinstance(v, bool)
    if s == "integer":
        return is_safe_integer(v)
    if s == "scalar":
        return isinstance(v, (str, int, float))  # bool is an int
    if s == "params":
        return _is_params(v)
    if isinstance(s, list):
        return isinstance(v, (list, tuple)) and all(_fits(x, s[0]) for x in v)
    return isinstance(v, dict) and all(_member(v, k, t) for k, t in s.items())


def _member(o: dict, k: str, t: Any) -> bool:
    if not k.endswith("?"):
        return _fits(o.get(k, _ABSENT), t)
    v = o.get(k[:-1])
    return v is None or _fits(v, t)


def more_fits(frame: dict) -> bool:
    """True when the frame's ``more`` is absent, null or well-formed."""
    return _member(frame, "more?", _MORE)


def kind_fits(frame: dict) -> bool:
    """True when the frame is of a known kind and has every member that kind's rendering reads."""
    kind = frame.get("kind")
    shape = _KINDS.get(kind) if isinstance(kind, str) else None
    return shape is not None and _fits(frame, shape)
