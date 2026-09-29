"""The plan hash: what an approval binds to (SPEC-approval §1)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .._json import CanonicalError, canonical, sha256_b64url
from ..lens.depth import MAX_EFFECT_DEPTH, effects_too_deep
from ..risk import known_risk
from ..uses import check_uses


def plan_preimage(tool: str, input: Any, plan: Any, risk: str) -> dict:
    """``{tool, input, summary, effects, uses, risk, undoWindow}``, absent optional fields left out."""
    known_risk(risk)  # a plan with an unknown risk never gets a plan hash
    # A person approves what the form shows, so nothing in an effect may be cut from it (SPEC §6.6).
    if effects_too_deep(plan.effects):
        raise ValueError(f"plan has effects nested past {MAX_EFFECT_DEPTH} levels, too deep to show in full")
    pre: dict[str, Any] = {"tool": tool, "input": input, "summary": plan.summary, "effects": plan.effects}
    uses = check_uses(plan.uses)
    if uses is not None:
        pre["uses"] = uses
    pre["risk"] = risk
    if plan.undo_window is not None:
        pre["undoWindow"] = plan.undo_window
    return pre


def plan_hash(tool: str, input: Any, plan: Any, risk: str) -> str:
    """``b64url(sha256(canonical(preimage)))``. Raises ValueError when the input holds a number
    that isn't an integer, since canonical JSON has none."""
    try:
        return sha256_b64url(canonical(plan_preimage(tool, input, plan, risk)).encode("utf-8"))
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
    can be undone (it has an undo window and the tool has ``revert``)."""

    tool: str
    plan: Any
    plan_hash: str
    risk: str
    undoable: bool
