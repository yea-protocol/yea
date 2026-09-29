"""The Lens lines of each reply kind but PROPOSALS (SPEC §9.2): a brief, a clarifying question, a receipt, an
error and an event."""

from __future__ import annotations

import math

from .._json import compact
from .format import _param_list, effect_line, fmt_duration, fmt_time
from .notation import _entry_lines


def _brief(r: dict) -> list[str]:
    svc = r.get("service") or {}
    lines = [f"# {svc.get('name', '')} ({svc.get('id', '')})"]
    if svc.get("summary"):
        lines.append(svc["summary"])
    for c in r.get("capabilities") or []:
        line = f"{c.get('kind', '')} {c.get('name', '')}{_param_list(c.get('params'))}"
        if c.get("summary"):
            line += f" — {c['summary']}"
        if c.get("risk"):
            line += f" [risk:{c['risk']}]"
        lines.append(line)
    return lines


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
    p = r.get("progress")
    if type(p) in (int, float) and 0 <= p <= 1:  # anything else is left out (§9.2 malformed values)
        line += f" ({math.floor(p * 100 + 0.5)}%)"  # JS Math.round semantics
    return [line]
