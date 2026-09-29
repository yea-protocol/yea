"""Rendering a reply frame as Lens (SPEC §9.2): its kind's lines, then any ``more`` lines."""

from __future__ import annotations

from .format import more_line
from .notation import lean
from .proposals import _proposals
from .replies import _brief, _clarify, _error, _event, _receipt

_RENDERERS = {
    "BRIEF": _brief,
    "PROPOSALS": _proposals,
    "CLARIFY": _clarify,
    "RECEIPT": _receipt,
    "ERROR": _error,
    "EVENT": _event,
    "ANSWER": lambda r: [lean(r.get("data"))],
}

# Not shown for a frame of unknown kind: the envelope, `more` (it has its own lines) and a
# service-supplied `lens`, which Lens never shows.
_HIDDEN = ("yea", "id", "re", "more", "lens")


def lens(reply: dict) -> str:
    """Render a reply frame. Ignores any service-supplied ``lens`` field."""
    kind = reply.get("kind")
    render = _RENDERERS.get(kind) if isinstance(kind, str) else None
    # An unknown (or missing, or non-string) kind: the frame's other members in lean notation (§9.2).
    lines = render(reply) if render else [lean({k: v for k, v in reply.items() if k not in _HIDDEN})]
    lines.extend(more_line(m) for m in reply.get("more") or [])
    return "\n".join(lines)
