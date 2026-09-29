"""Rendering a reply frame as Lens (SPEC §9.2): its kind's lines, then any ``more`` lines."""

from __future__ import annotations

from .depth import clip_depth
from .format import more_line
from .notation import lean
from .proposals import _proposals
from .replies import _brief, _clarify, _error, _event, _receipt
from .shape import kind_fits, more_fits

_RENDERERS = {
    "BRIEF": _brief,
    "PROPOSALS": _proposals,
    "CLARIFY": _clarify,
    "RECEIPT": _receipt,
    "ERROR": _error,
    "EVENT": _event,
    "ANSWER": lambda r: [lean(r.get("data"))],
}

# Not shown for a frame of unknown kind: the envelope, `more` (it has its own lines, when
# well-formed) and a service-supplied `lens`, which Lens never shows.
_HIDDEN = ("yea", "id", "re", "lens")


def lens(reply: dict) -> str:
    """Render a reply frame, clipped to ``MAX_DEPTH``. Ignores any service-supplied ``lens`` field. A
    missing, wrong-typed or deeply nested member can't make it raise."""
    frame = clip_depth(reply) if isinstance(reply, dict) else {}
    more_ok = more_fits(frame)
    if more_ok and kind_fits(frame):
        lines = _RENDERERS[frame["kind"]](frame)
    else:
        # An unknown (or missing, or non-string) kind, or not well-formed: the frame's other members
        # in lean notation, a malformed `more` among them (§9.2).
        lines = [lean({k: v for k, v in frame.items() if k not in _HIDDEN and (k != "more" or not more_ok)})]
    if more_ok:
        lines.extend(more_line(m) for m in frame.get("more") or [])
    return "\n".join(lines)
