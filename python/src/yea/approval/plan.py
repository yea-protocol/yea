"""The plan hash: what an approval binds to, and the plan as a person is shown it (SPEC-approval §1)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .._json import CanonicalError, canonical, sha256_b64url
from ..lens.depth import MAX_APPROVAL_DEPTH, too_deep_to_approve
from ..risk import known_risk
from ..undo_window import undo_window_of
from ..uses import check_uses


@dataclass(frozen=True)
class JudgedPlan:
    """What a plan's preimage is built from: its tool, the plan, its resolved risk and whether it
    can be undone. A ``HashedPlan`` has the same attributes, so it is accepted wherever this is."""

    tool: str
    plan: Any
    risk: str
    undoable: bool


@dataclass(frozen=True)
class HashedPlan:
    """A plan with what approval needs: its tool, its hash, its resolved risk, and whether it
    can be undone (its undo window is a positive integer and the tool has ``revert``)."""

    tool: str
    plan: Any
    plan_hash: str
    risk: str
    undoable: bool


def plan_too_deep(plan: Any) -> bool:
    """True when the part of a plan a person reads (summary, effects, uses) nests too deep to show in
    full, so it can't be approved (SPEC §6.6): nothing approved may be cut from view."""
    return too_deep_to_approve({"summary": plan.summary, "effects": plan.effects, "uses": plan.uses})


def shown_plan(judged: JudgedPlan | HashedPlan) -> dict:
    """The plan as a person is shown it and its hash binds it: the plan-hash preimage without
    ``tool`` and ``input``, absent optional fields left out. ``undoWindow`` is there only when the
    plan is undoable, so hashing, the form, the MCP results and ``yea approve`` all read undo from
    this one field. It's checked again, so a hand-built plan can't put a window that isn't one in
    view."""
    plan = judged.plan
    shown: dict[str, Any] = {"summary": plan.summary, "effects": plan.effects}
    uses = check_uses(plan.uses)
    if uses is not None:
        shown["uses"] = uses
    shown["risk"] = judged.risk
    window = undo_window_of(plan.undo_window)
    if judged.undoable and window is not None:
        shown["undoWindow"] = window
    return shown


def plan_preimage(input: Any, judged: JudgedPlan | HashedPlan) -> dict:
    """``{tool, input, summary, effects, uses, risk, undoWindow}``, absent optional fields left out.
    ``undoWindow`` is left out too unless the plan is undoable (§1)."""
    known_risk(judged.risk)  # a plan with an unknown risk never gets a plan hash
    if plan_too_deep(judged.plan):
        raise ValueError(f"plan is nested past {MAX_APPROVAL_DEPTH} levels, too deep to show in full")
    return {"tool": judged.tool, "input": input, **shown_plan(judged)}


def plan_hash(input: Any, judged: JudgedPlan | HashedPlan) -> str:
    """``b64url(sha256(canonical(preimage)))``. Raises ValueError when the input holds a number
    that isn't an integer, since canonical JSON has none."""
    try:
        return sha256_b64url(canonical(plan_preimage(input, judged)).encode("utf-8"))
    except CanonicalError as e:
        raise ValueError(
            f"{judged.tool}: a job tool's input and plans may hold only integer numbers ({e}); use a string or an integer instead"
        ) from None


def input_hash(input: Any) -> str:
    try:
        return sha256_b64url(canonical(input).encode("utf-8"))
    except CanonicalError as e:
        raise ValueError(f"a job tool's input may hold only integer numbers ({e}); use a string or an integer instead") from None
