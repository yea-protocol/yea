"""A round's plans (SPEC-approval §1): the handler's answer hashed, or what to return instead (its
question, or a refusal when it has no plans); and the phrase the person types for each plan."""

from __future__ import annotations

import inspect
from collections.abc import Callable
from typing import Any

from ..approval import HashedPlan, checked_phrase, plan_hash
from ..risk import resolve_risk
from ..service import Clarification, Plan
from .outcome import JobCall, JobTool, Outcome


def hash_plans(tool: JobTool, input: dict, plans: list[Any]) -> list[HashedPlan]:
    """Hash each plan and resolve its risk (plan, else the tool's, else ``medium``). An unknown
    risk, or a plan that isn't a ``yea.Plan``, refuses the call."""
    out = []
    for p in plans:
        if not isinstance(p, Plan):
            raise TypeError("a job's plan function must return a list of yea.Plan, or clarify(...)")
        risk = resolve_risk("medium", p.risk, tool.risk)
        undoable = p.undo_window is not None and tool.revert is not None
        out.append(HashedPlan(tool.name, p, plan_hash(tool.name, input, p, risk), risk, undoable))
    return out


async def plans_of(call: JobCall) -> list[HashedPlan] | Outcome:
    """The handler's plans, hashed, or the outcome that ends the round before any plan is judged."""
    out = call.plan()
    out = await out if inspect.isawaitable(out) else out
    if isinstance(out, Clarification):
        return Outcome("clarify", clarification=out)
    if not isinstance(out, (list, tuple)):
        raise TypeError("a job's plan function must return a list of plans or clarify(...)")
    if not out:
        return Outcome("refuse", f"{call.tool.name} has no way to do this")
    return hash_plans(call.tool, call.input, list(out))


def phrase_of(call: JobCall) -> Callable[[HashedPlan], str]:
    """The phrase the person types for a plan: the tool's, or ``approve``. One that isn't a string,
    or isn't typeable text (SPEC-approval §3), is the developer's error: the round raises before
    anyone is asked."""
    confirm = call.tool.confirm_with

    def phrase(hp: HashedPlan) -> str:
        p = confirm(hp, call.input) if confirm else ""
        if not isinstance(p, str):
            raise TypeError("confirm_with() must return a string")
        return checked_phrase(p, "the phrase from confirm_with()")

    return phrase
