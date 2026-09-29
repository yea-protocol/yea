"""The Lens lines of a PROPOSALS reply (SPEC §9.2): each proposal with its effects and attributes, the
attributes they all share stated once."""

from __future__ import annotations

from ..uses import fmt_uses
from .format import effect_line, fmt_duration, fmt_time
from .notation import _entry_lines, scalar

# Each renders a proposal's attribute, or None when it's omitted (only `uses` can be).
_ATTRS = (
    ("uses", lambda p: fmt_uses(p["uses"]) if "uses" in p else None),
    ("risk", lambda p: scalar(p.get("risk"))),
    ("undo", lambda p: fmt_duration(p["undo"]["window"]) if isinstance(p.get("undo"), dict) and "window" in p["undo"] else "never"),
    ("expires", lambda p: fmt_time(p.get("expires"))),
)


def _proposals(r: dict) -> list[str]:
    ps = r.get("proposals") or []
    # Attributes identical across all (N >= 2) proposals are stated once, in the header.
    shared = [a for a in _ATTRS if len(ps) >= 2 and all(a[1](p) == a[1](ps[0]) for p in ps)]
    own = [a for a in _ATTRS if a not in shared]
    head = f"{len(ps)} proposal{'' if len(ps) == 1 else 's'}"
    if head_attrs := _attr_line(shared, ps[0] if ps else {}):
        head += " — " + head_attrs
    lines = [head + ":"]
    for p in ps:
        lines.append(f"[{p.get('id', '')}] {p.get('summary', '')}")
        lines.extend("  " + effect_line(e) for e in p.get("effects") or [])
        if attrs := _attr_line(own, p):
            lines.append("  " + attrs)
        if "data" in p:
            lines.extend(_entry_lines("data", p["data"], 1))
    return lines


def _attr_line(attrs: list, p: dict) -> str:
    """``k: v · k: v`` for the attributes ``p`` renders; omitted ones are skipped."""
    return " · ".join(f"{k}: {v}" for k, f in attrs if (v := f(p)) is not None)
