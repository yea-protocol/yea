"""What a job call does with its plans under a policy: run, ask, out of band, or refuse (SPEC-approval §2)."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from ..grants import Grant, GrantContext, verify_grant
from ..risk import at_least
from ..store import LedgerKey
from ..uses import check_uses, limit_value, same_unit, value
from .plan import HashedPlan
from .policy import Policy


@dataclass(frozen=True)
class Decision:
    """``nothing`` | ``denied`` | ``out-of-band`` | ``ask`` | ``run``."""

    kind: str
    why: str | None = None
    plan: HashedPlan | None = None
    reserve: tuple[tuple[LedgerKey, int, int], ...] = ()  # (key, amount, max) to reserve before apply


def decide(plans: list[HashedPlan], policy: Policy, used: Callable[[LedgerKey], int], now: int) -> Decision:
    """What a job call should do with these plans under this policy, at ``now`` (a policy loaded
    earlier still expires on time). Only ``plans[0]`` can run."""
    if not plans:
        return Decision("nothing")
    first = plans[0]
    if first.tool in policy.deny:
        return Decision("denied", denied_reason(first.tool))
    if at_least(first.risk, policy.out_of_band):
        return Decision("out-of-band", f"risk is {first.risk}, which needs approval outside the chat")
    why = needs_approval(first, policy, used, now)
    if why is not None:
        return Decision("ask", why)
    return Decision("run", plan=first, reserve=_reservations(first, policy))


def needs_approval(p: HashedPlan, policy: Policy, used: Callable[[LedgerKey], int], now: int) -> str | None:
    """Why ``p`` can't run without asking, or None (§2's conditions, in the pinned order)."""
    if not p.undoable:
        return f"{p.tool} can't be undone"
    if policy.grant is None or policy.server_key is None or policy.principal is None:
        return f"no signed policy lets {p.tool} run without asking"
    uses = check_uses(p.plan.uses)
    proposal: dict[str, Any] = {"hash": p.plan_hash, "risk": p.risk, **({"uses": uses} if uses is not None else {})}
    spent = {(bid, lim["of"]): used(LedgerKey(bid, lim["of"])) for bid, lim in policy.totals}
    if isinstance(policy.grant, Grant) and not _names_tools(policy.grant):
        return f"the signed policy names no tools, so it doesn't let {p.tool} run without asking"
    ctx = GrantContext(policy.server_key, "COMMIT", p.tool, now, proposal, spent)
    v = verify_grant(policy.grant, [policy.principal], policy.server_key, ctx)
    return None if v.ok else v.reason


def _names_tools(g: Grant) -> bool:
    """§2 condition 1 needs a ``can`` that covers the tool: a grant with no ``can`` at all
    (which the protocol reads as "any capability") doesn't auto-run job tools."""
    return any(isinstance(c, dict) and "can" in c for b in g.blocks for c in b["p"]["caveats"])


def denied_reason(tool: str) -> str:
    return f"your policy never allows {tool}"


def _reservations(p: HashedPlan, policy: Policy) -> tuple[tuple[LedgerKey, int, int], ...]:
    uses = check_uses(p.plan.uses) or {}
    out = []
    for bid, lim in policy.totals:
        q = uses.get(lim["of"])
        if q is not None and same_unit(q, lim):
            out.append((LedgerKey(bid, lim["of"]), value(q), limit_value(lim)))
    return tuple(out)
