"""Undo windows (SPEC §5.1, SPEC-approval §1): only a positive whole number of seconds is one.
Anything else, zero included, means the action can't be undone. Mirrors ts/src/undo-window.ts."""

from __future__ import annotations

from typing import Any

from ._json import MAX_SAFE_INT


def is_undo_window(v: Any) -> bool:
    """Whether ``v`` is an undo window: a whole number of seconds from 1 to 2^53−1 (an
    integer-valued float counts, as in JS). Zero, negatives, fractions, strings, booleans and
    everything else are not, so a plan with one is not undoable, a service sends ``undo: null``
    for it, and every renderer shows ``never``."""
    if type(v) is float and v.is_integer():
        v = int(v)
    return type(v) is int and 0 < v <= MAX_SAFE_INT
