"""Estimating the tokens in Lens text (SPEC §8), the same way in every implementation."""

from __future__ import annotations

import re

_EST = re.compile(r"[A-Za-z]+|[0-9]{1,3}|\n {2,}|[^ \t\n\r\f\vA-Za-z0-9]")


def est(text: str) -> int:
    """Shared token estimate (SPEC §8): letter runs, digit groups of up to three,
    indentation runs, and each other visible code point."""
    return sum(1 for _ in _EST.finditer(text))
