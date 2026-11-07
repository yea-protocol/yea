"""One plan as a person reads it (SPEC-approval §3, §6): the form and the MCP results both show a
plan with these lines. Mirrors ts/src/ask/plan-text.ts."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from ..lens import fmt_duration, safe_effect_line
from ..text import printable
from ..undo_window import is_undo_window
from ..uses import fmt_uses


def plan_lines(shown: Mapping[str, Any], n: int | None = None) -> list[str]:
    """``shown`` (a ``shown_plan``) as its summary (after ``[n]`` when ``n`` is given), its effects,
    then what it uses, its risk and its undo. Service text is untrusted, so it's escaped: a summary
    can't forge a line or hide characters. Undo is the window only when it is one (§1), else
    ``never``."""
    attrs = [f"uses: {u}"] if (u := fmt_uses(shown.get("uses", {}))) is not None else []
    window = shown.get("undoWindow")
    attrs += [f"risk: {shown['risk']}", f"undo: {fmt_duration(window) if is_undo_window(window) else 'never'}"]
    head = f"[{n}] " if n is not None else ""
    return [head + printable(shown["summary"]), *("  " + safe_effect_line(e) for e in shown["effects"]),
            "  " + " · ".join(attrs)]
