"""What a job call does with its plans under a policy: run, ask, out of band, or refuse (SPEC-approval §2)."""

from __future__ import annotations

import math

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from ..grants import Grant, GrantContext, TotalLimit, Verification, total_keys, verify_grant
from ..risk import at_least
from ..store import LedgerKey
from ..uses import check_uses, value
from .plan import HashedPlan
from .policy import Policy


@dataclass(frozen=True)
class Decision:
    """``nothing`` | ``denied`` | ``out-of-band`` | ``ask`` | ``run``."""

    kind: str
    why: str | None = None
    plan: HashedPlan | None = None
    reserve: tuple[tuple[LedgerKey, int, int], ...] = ()  # (key, amount, max) to reserve before apply


def ruled_out(p: HashedPlan, policy: Policy) -> Decision | None:
    """The one check of a plan against the unsigned rules (§2): ``denied``, or ``out-of-band`` (at
    or above ``out_of_band``, so approved only outside the chat), with why; None when neither."""
    if p.tool in policy.deny:
        return Decision("denied", denied_reason(p.tool))
    if at_least(p.risk, policy.out_of_band):
        return Decision("out-of-band", out_of_band_reason(p))
    return None


def decide(plans: list[HashedPlan], policy: Policy, used: Callable[[LedgerKey], int], now: float) -> Decision:
    """What a job call should do with these plans under this policy, at ``now`` in whole seconds (a
    policy loaded earlier still expires on time). Only ``plans[0]`` can run. Its reservations carry
    the periods the check worked out at ``now``, so an amount counts in the period that was checked."""
    if not plans:
        return Decision("nothing")
    first = plans[0]
    out = ruled_out(first, policy)
    if out is not None:
        return out
    checked = _check(first, policy, used, math.floor(now))
    if isinstance(checked, str):
        return Decision("ask", checked)
    return Decision("run", plan=first, reserve=_reservations(first, checked.totals))


def needs_approval(p: HashedPlan, policy: Policy, used: Callable[[LedgerKey], int], now: int) -> str | None:
    """Why ``p`` can't run without asking, or None (§2's conditions, in the pinned order)."""
    checked = _check(p, policy, used, now)
    return checked if isinstance(checked, str) else None


def _check(p: HashedPlan, policy: Policy, used: Callable[[LedgerKey], int], now: int) -> str | Verification:
    """Why ``p`` can't run without asking, or the policy grant's check that lets it run."""
    if not p.undoable:
        return f"{p.tool} can't be undone"
    if policy.grant is None or policy.server_key is None or policy.principal is None:
        return f"no signed policy lets {p.tool} run without asking"
    uses = check_uses(p.plan.uses)
    proposal: dict[str, Any] = {"hash": p.plan_hash, "risk": p.risk, **({"uses": uses} if uses is not None else {})}
    g = policy.grant
    keys = total_keys(g.blocks, g.block_ids, now) if isinstance(g, Grant) else []
    if isinstance(g, Grant) and not _names_tools(g):
        return f"the signed policy names no tools, so it doesn't let {p.tool} run without asking"
    ctx = GrantContext(policy.server_key, "COMMIT", p.tool, now, proposal, {k: used(k) for k in keys})
    v = verify_grant(g, [policy.principal], policy.server_key, ctx)
    return v if v.ok else v.reason


def _names_tools(g: Grant) -> bool:
    """§2 condition 1 needs a ``can`` that covers the tool: a grant with no ``can`` at all
    (which the protocol reads as "any capability") doesn't auto-run job tools."""
    return any(isinstance(c, dict) and "can" in c for b in g.blocks for c in b["p"]["caveats"])


def denied_reason(tool: str) -> str:
    return f"your policy never allows {tool}"


def out_of_band_reason(p: HashedPlan) -> str:
    return f"risk is {p.risk}, which needs approval outside the chat"


def _reservations(p: HashedPlan, totals: list[TotalLimit]) -> tuple[tuple[LedgerKey, int, int], ...]:
    """One (key, amount, max) per ledger key the plan uses; a repeated ``total`` keeps its smallest
    ``max``. Totals on one measure with a different ``every`` have different keys, so each reserves."""
    uses = check_uses(p.plan.uses) or {}
    out: dict[LedgerKey, tuple[LedgerKey, int, int]] = {}
    for t in totals:
        q = uses.get(t.key.of)
        if q is not None and (t.key not in out or t.max < out[t.key][2]):
            out[t.key] = (t.key, value(q), t.max)
    return tuple(out.values())
