"""Undo windows (SPEC §5.1, SPEC-approval §1): only a positive whole number of seconds, small
enough that a commit time plus it is still a safe integer, is one. Anything else, zero included,
means the action can't be undone. Mirrors ts/src/undo-window.ts."""

from __future__ import annotations

from typing import Any

# The longest undo window, in seconds: 2^52 (about 142 million years), so a receipt's ``until``,
# the commit time plus the window, stays a safe integer for any commit before then.
MAX_UNDO_WINDOW = 2**52


def undo_window_of(v: Any) -> int | None:
    """``v`` as an undo window: a whole number of seconds from 1 to ``MAX_UNDO_WINDOW``, as an int
    (an integer-valued float counts, as in JS, so ``3600.0`` is ``3600``). None for zero,
    negatives, fractions, strings, booleans, None, larger numbers and everything else: a plan with
    one is not undoable, a service sends ``undo: null`` for it, and every renderer shows ``never``."""
    if type(v) is float and v.is_integer():
        v = int(v)
    return v if type(v) is int and 0 < v <= MAX_UNDO_WINDOW else None


def is_undo_window(v: Any) -> bool:
    """Whether ``v`` is an undo window (see ``undo_window_of``)."""
    return undo_window_of(v) is not None
