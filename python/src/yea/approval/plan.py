"""The plan hash: what an approval binds to, and the plan as a person is shown it (SPEC-approval §1)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .._json import CanonicalError, canonical, sha256_b64url
from ..lens.depth import MAX_APPROVAL_DEPTH, too_deep_to_approve
from ..risk import known_risk
from ..undo_window import is_undo_window
from ..uses import check_uses


def plan_too_deep(plan: Any) -> bool:
    """True when the part of a plan a person reads (summary, effects, uses) nests too deep to show in
    full, so it can't be approved (SPEC §6.6): nothing approved may be cut from view."""
    return too_deep_to_approve({"summary": plan.summary, "effects": plan.effects, "uses": plan.uses})


def _shown(plan: Any, risk: str, undoable: bool) -> dict:
    """``{summary, effects, uses, risk, undoWindow}``, absent optional fields left out. The window is
    there only when the plan is undoable, so hashing, the form, the MCP results and ``yea approve``
    all read undo from this one field. It's checked again, so a hand-built ``HashedPlan`` can't
    put a window that isn't one in view."""
    shown: dict[str, Any] = {"summary": plan.summary, "effects": plan.effects}
    uses = check_uses(plan.uses)
    if uses is not None:
        shown["uses"] = uses
    shown["risk"] = risk
    if undoable and is_undo_window(plan.undo_window):
        shown["undoWindow"] = int(plan.undo_window)  # 3600.0 is 3600, as in JS
    return shown


def plan_preimage(tool: str, input: Any, plan: Any, risk: str, *, undoable: bool) -> dict:
    """``{tool, input, summary, effects, uses, risk, undoWindow}``, absent optional fields left out.
    ``undoWindow`` is left out too unless the plan is undoable (§1)."""
    known_risk(risk)  # a plan with an unknown risk never gets a plan hash
    if plan_too_deep(plan):
        raise ValueError(f"plan is nested past {MAX_APPROVAL_DEPTH} levels, too deep to show in full")
    return {"tool": tool, "input": input, **_shown(plan, risk, undoable)}


def plan_hash(tool: str, input: Any, plan: Any, risk: str, *, undoable: bool) -> str:
    """``b64url(sha256(canonical(preimage)))``. Raises ValueError when the input holds a number
    that isn't an integer, since canonical JSON has none."""
    try:
        return sha256_b64url(canonical(plan_preimage(tool, input, plan, risk, undoable=undoable)).encode("utf-8"))
    except CanonicalError as e:
        raise ValueError(
            f"{tool}: a job tool's input and plans may hold only integer numbers ({e}); use a string or an integer instead"
        ) from None


def input_hash(input: Any) -> str:
    try:
        return sha256_b64url(canonical(input).encode("utf-8"))
    except CanonicalError as e:
        raise ValueError(f"a job tool's input may hold only integer numbers ({e}); use a string or an integer instead") from None


@dataclass(frozen=True)
class HashedPlan:
    """A plan with what approval needs: its tool, its hash, its resolved risk, and whether it
    can be undone (its undo window is a positive integer and the tool has ``revert``)."""

    tool: str
    plan: Any
    plan_hash: str
    risk: str
    undoable: bool


def shown_plan(hp: HashedPlan) -> dict:
    """The plan as a person is shown it and its hash binds it: the plan-hash preimage without
    ``tool`` and ``input``, with ``undoWindow`` only when the plan is undoable."""
    return _shown(hp.plan, hp.risk, hp.undoable)
