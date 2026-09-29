"""How deep Lens renders (SPEC §9.1, depth): objects and arrays nested past ``MAX_DEPTH`` render as
``…``, so a deeply nested value can't overflow the stack in any implementation."""

from __future__ import annotations

from typing import Any

# The levels of objects and arrays Lens renders below the value (or frame) it's given.
MAX_DEPTH = 64

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
