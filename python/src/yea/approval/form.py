"""The approval form: the plans as the person reads them, and the fields to answer (SPEC-approval §3)."""

from __future__ import annotations

from collections.abc import Callable

from ..lens import fmt_duration, safe_effect_line
from ..risk import at_least
from ..text import printable
from ..uses import check_uses, fmt_uses
from .phrase import phrase_of
from .plan import HashedPlan
from .policy import Policy


def offered_plans(plans: list[HashedPlan], policy: Policy) -> list[HashedPlan]:
    """The plans the form may offer: not denied, and below ``out_of_band``."""
    return [p for p in plans if p.tool not in policy.deny and not at_least(p.risk, policy.out_of_band)]


def build_form(plans: list[HashedPlan], why: str, policy: Policy, phrase_for: Callable[[HashedPlan], str]) -> dict | None:
    """``{message, requested_schema, offered}`` for a form-mode elicitation (§3). Plans that are
    denied or at or above ``out_of_band`` are described but can't be chosen here. None when no
    plan can be chosen: the caller fails closed with consent codes instead of asking."""
    offered = offered_plans(plans, policy)
    if not offered:
        return None
    lines = [f"Approval needed: {printable(why)}.", ""]
    for i, p in enumerate(plans, 1):
        lines.extend(_plan_lines(i, p))
        if p in offered:
            lines.append(f"  to approve, type: {printable(phrase_of(p, phrase_for))}")
    held = [f"[{i}]" for i, p in enumerate(plans, 1) if p not in offered and p.tool not in policy.deny]
    denied = [f"[{i}]" for i, p in enumerate(plans, 1) if p.tool in policy.deny]
    if held:
        lines.extend(["", f"Not offered here (approve outside the chat): {', '.join(held)}"])
    if denied:
        lines.extend(["", f"Never allowed by your policy: {', '.join(denied)}"])
    return {"message": "\n".join(lines), "requested_schema": _schema(offered, phrase_for), "offered": [p.plan_hash for p in offered]}


def _plan_lines(n: int, p: HashedPlan) -> list[str]:
    attrs = []
    if (u := fmt_uses(check_uses(p.plan.uses) or {})) is not None:
        attrs.append(f"uses: {u}")
    attrs.append(f"risk: {p.risk}")
    attrs.append(f"undo: {fmt_duration(p.plan.undo_window)}" if p.undoable else "undo: never")
    # Service text is untrusted: escaped, so a summary can't forge lines or hide characters (#100).
    return [f"[{n}] {printable(p.plan.summary)}", *("  " + safe_effect_line(e) for e in p.plan.effects),
            "  " + " · ".join(attrs)]


def _schema(offered: list[HashedPlan], phrase_for: Callable[[HashedPlan], str]) -> dict:
    if len(offered) == 1:
        confirm = {"type": "string", "title": "Confirm", "description": f'Type "{printable(phrase_of(offered[0], phrase_for))}" to approve.'}
        return {"type": "object", "properties": {"confirm": confirm}, "required": ["confirm"]}
    plan = {"type": "string", "title": "Plan",
            "oneOf": [{"const": p.plan_hash, "title": printable(p.plan.summary)} for p in offered]}
    confirm = {"type": "string", "title": "Confirm", "description": "Type the chosen plan's phrase, shown next to it above."}
    return {"type": "object", "properties": {"plan": plan, "confirm": confirm}, "required": ["plan", "confirm"]}
