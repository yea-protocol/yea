"""Rendering a reply frame as Lens, one renderer per kind (SPEC §9.2)."""

from __future__ import annotations

import math

from .._json import compact
from ..uses import fmt_uses
from .fields import effect_line, fmt_duration, fmt_time, more_line, param_list
from .lean import _entry_lines, lean


def _brief(r: dict) -> list[str]:
    svc = r.get("service") or {}
    lines = [f"# {svc.get('name', '')} ({svc.get('id', '')})"]
    if svc.get("summary"):
        lines.append(svc["summary"])
    for c in r.get("capabilities") or []:
        line = f"{c.get('kind', '')} {c.get('name', '')}{param_list(c.get('params'))}"
        if c.get("summary"):
            line += f" — {c['summary']}"
        if c.get("risk"):
            line += f" [risk:{c['risk']}]"
        lines.append(line)
    return lines


# Each renders a proposal's attribute, or None when it's omitted (only `uses` can be).
_ATTRS = (
    ("uses", lambda p: fmt_uses(p["uses"]) if "uses" in p else None),
    ("risk", lambda p: str(p.get("risk", "-"))),
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


def _clarify(r: dict) -> list[str]:
    lines = [f"? {r.get('question', '')}"]
    lines.extend(f"  {i}. {o.get('label', '')}" for i, o in enumerate(r.get("options") or [], 1))
    return lines


def _receipt(r: dict) -> list[str]:
    rc = r.get("receipt") or {}
    tag = f"(receipt {rc.get('id', '')})" + (" (replay)" if r.get("replay") else "")
    if rc.get("undoes"):
        lines = [f"↶ undid {rc['undoes']}: {rc.get('summary', '')} {tag}"]
    else:
        undo = rc.get("undo")
        when = f"undo until {fmt_time(undo['until'])}" if isinstance(undo, dict) and "until" in undo else "irreversible"
        lines = [f"✓ {rc.get('summary', '')} {tag} · {when}"]
    if r.get("auto"):  # otherwise the model already read the effects in the proposal
        lines.extend("  " + effect_line(e) for e in rc.get("effects") or [])
    if "result" in rc:
        lines.extend(_entry_lines("result", rc["result"], 1))
    return lines


def _error(r: dict) -> list[str]:
    lines = [f"✗ {r.get('code', '')}: {r.get('message', '')}"]
    for f in r.get("fix") or []:
        line = f"  fix: {f.get('say', '')}"
        if f.get("params") is not None:
            line += f" → params {compact(f['params'])}"
        lines.append(line)
    if r.get("need"):
        lines.append(f"  need: {compact(r['need'])}")
    consent = r.get("consent")
    if consent:
        lines.append(f"  consent: principal must approve {consent.get('hash', '')} ({consent.get('summary', '')})")
    if isinstance(r.get("retry"), (int, float)) and not isinstance(r.get("retry"), bool):
        lines.append(f"  retry in: {fmt_duration(r['retry'])}")
    return lines


def _event(r: dict) -> list[str]:
    line = f"… {r.get('message', '')}"
    if r.get("progress") is not None:
        line += f" ({math.floor(r['progress'] * 100 + 0.5)}%)"  # JS Math.round semantics
    return [line]


_RENDERERS = {
    "BRIEF": _brief,
    "PROPOSALS": _proposals,
    "CLARIFY": _clarify,
    "RECEIPT": _receipt,
    "ERROR": _error,
    "EVENT": _event,
    "ANSWER": lambda r: [lean(r.get("data"))],
}


def lens(reply: dict) -> str:
    """Render a reply frame. Ignores any service-supplied ``lens`` field."""
    render = _RENDERERS.get(reply.get("kind", ""))
    lines = render(reply) if render else [lean({k: v for k, v in reply.items() if k not in ("yea", "id", "re")})]
    lines.extend(more_line(m) for m in reply.get("more") or [])
    return "\n".join(lines)
