"""How the person's answer is judged against the recomputed plans (SPEC-approval §5)."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any

from .decide import at_least, denied_reason
from .phrase import phrase_matches, phrase_of
from .plan import HashedPlan
from .policy import Policy
from .state import MAX_ROUNDS


@dataclass(frozen=True)
class Verdict:
    """``refuse`` | ``not-approved`` | ``ask-again`` | ``denied`` | ``out-of-band`` | ``run``."""

    kind: str
    why: str | None = None
    round: int | None = None
    plan: HashedPlan | None = None


def judge_answer(state: dict, answer: Mapping[str, Any], recomputed: list[HashedPlan], policy: Policy,
                 phrase_for: Callable[[HashedPlan], str]) -> Verdict:
    """Steps 3–7 of §5, after the state was verified and its nonce consumed."""
    if answer.get("action") != "accept":
        return Verdict("not-approved", "not approved")
    content = answer.get("content") if isinstance(answer.get("content"), dict) else {}
    pick = _picked(state, content)
    if pick is None:
        return Verdict("refuse", "that plan was not offered")
    chosen = next((p for p in recomputed if p.plan_hash == pick), None)
    if chosen is None:
        return _again(state, "the plans changed; choose again")
    if chosen.tool in policy.deny:
        return Verdict("denied", denied_reason(chosen.tool))
    if at_least(chosen.risk, policy.out_of_band):
        return Verdict("out-of-band", plan=chosen)
    phrase = phrase_of(chosen, phrase_for)
    if not phrase_matches(content.get("confirm"), phrase):
        return _again(state, f'type "{phrase}" exactly to approve')
    return Verdict("run", plan=chosen)


def _picked(state: dict, content: Mapping[str, Any]) -> str | None:
    """The chosen plan hash, if it was one of the offered ones. With one offered plan the form
    has no ``plan`` field, so that one is chosen."""
    offered = state["plans"]
    pick = content.get("plan")
    if not isinstance(pick, str) and len(offered) == 1:
        pick = offered[0]
    return pick if isinstance(pick, str) and pick in offered else None


def _again(state: dict, why: str) -> Verdict:
    if state["round"] + 1 > MAX_ROUNDS:
        return Verdict("refuse", f"not approved after {MAX_ROUNDS} tries")
    return Verdict("ask-again", why, state["round"] + 1)
