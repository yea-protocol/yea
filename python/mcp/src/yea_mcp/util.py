"""Small helpers the job server shares."""

from __future__ import annotations

import sys

_warned: set[str] = set()


def warn_once(message: str) -> None:
    """Warn on stderr once per message, so a per-call read doesn't flood the log."""
    if message not in _warned:
        _warned.add(message)
        print(f"yea: {message}", file=sys.stderr)
