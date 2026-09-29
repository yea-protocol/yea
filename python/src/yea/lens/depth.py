"""How deep Lens renders (SPEC §9.1, depth): objects and arrays nested past ``MAX_DEPTH`` render as
``…``, so a deeply nested value can't overflow the stack in any implementation."""

from __future__ import annotations

from typing import Any

# The levels of objects and arrays Lens renders below the value (or frame) it's given. It stays above a
# BRIEF param schema's reach (frame level 3 + the param depth limit in shape.py), so a schema is judged
# by its own limit, never by the cut.
MAX_DEPTH = 64

# How deep what a person approves may nest (SPEC §6.6): a proposal without its ``data``, or a plan's
# summary, effects and uses, itself being the first level. No view puts it more than two levels into
# its frame, so it always shows in full: approval never covers content cut to "…".
MAX_APPROVAL_DEPTH = 32

# What an object or array nested past MAX_DEPTH becomes: a string, so it renders as one.
_CUT = "…"


def clip_depth(v: Any, depth: int = 0) -> Any:
    """``v`` with every object or array ``MAX_DEPTH`` levels below it replaced by ``…``. It recurses
    at most ``MAX_DEPTH`` deep, and keeps key order."""
    if isinstance(v, dict):
        return {k: clip_depth(x, depth + 1) for k, x in v.items()} if depth < MAX_DEPTH else _CUT
    if isinstance(v, (list, tuple)):
        return [clip_depth(x, depth + 1) for x in v] if depth < MAX_DEPTH else _CUT
    return v


def nested_past(v: Any, levels: int, depth: int = 0) -> bool:
    """True when ``v`` holds an object or array ``levels`` or more levels below it (``v`` is level
    0), so clipping it to that many levels would cut something. It recurses at most ``levels`` deep."""
    if isinstance(v, dict):
        children = v.values()
    elif isinstance(v, (list, tuple)):
        children = v
    else:
        return False
    return depth >= levels or any(nested_past(x, levels, depth + 1) for x in children)



def too_deep_to_approve(v: Any) -> bool:
    """True when ``v``, something a person would approve, nests past ``MAX_APPROVAL_DEPTH``."""
    return nested_past(v, MAX_APPROVAL_DEPTH)
