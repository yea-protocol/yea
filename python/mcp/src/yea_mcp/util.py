"""Small helpers the job server shares."""

from __future__ import annotations

import sys
from typing import Any

_warned: set[str] = set()


def warn_once(message: str) -> None:
    """Warn on stderr once per message, so a per-call read doesn't flood the log."""
    if message not in _warned:
        _warned.add(message)
        print(f"yea: {message}", file=sys.stderr)


def fastmcp_of(server: Any) -> Any:
    """The FastMCP adapter module when ``server`` is a FastMCP server (the optional extra), else None."""
    if type(server).__module__.split(".")[0] != "fastmcp":
        return None
    from . import fastmcp

    return fastmcp
