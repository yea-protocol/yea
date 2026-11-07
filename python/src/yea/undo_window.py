"""Undo windows (SPEC §5.1, SPEC-approval §1): only a positive whole number of seconds is one.
Anything else, zero included, means the action can't be undone. Mirrors ts/src/undo-window.ts."""

from __future__ import annotations

from typing import Any

from ._json import MAX_SAFE_INT


def undo_window_of(v: Any) -> int | None:
    """``v`` as an undo window: a whole number of seconds from 1 to 2^53−1, as an int (an
    integer-valued float counts, as in JS, so ``3600.0`` is ``3600``). None for zero, negatives,
    fractions, strings, booleans and everything else: a plan with one is not undoable, a service
    sends ``undo: null`` for it, and every renderer shows ``never``."""
    if type(v) is float and v.is_integer():
        v = int(v)
    return v if type(v) is int and 0 < v <= MAX_SAFE_INT else None


def is_undo_window(v: Any) -> bool:
    """Whether ``v`` is an undo window (see ``undo_window_of``)."""
    return undo_window_of(v) is not None
