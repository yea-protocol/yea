"""What a call starts from: whose call it is and the policy that applies; and a guarded tool's plan."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from yea import Plan
from yea.approval import Policy, Tightening, load_policy

from ..policy import has_total, read_policy, read_tightening_for
from .model import Yea, _maybe


def caller_of(y: Yea, rctx: Any) -> str:
    """Who is calling; on HTTP an empty answer refuses the call."""
    sub = y.sub(rctx)
    if not isinstance(sub, str) or (y.transport == "http" and sub == ""):
        raise ValueError("no authenticated caller: the server's sub() returned no identity")
    return sub


def policy_for(y: Yea) -> Policy:
    """The policy for this call; raises when its totals can't be kept on this store."""
    rules = read_tightening_for(y.tighten)
    if rules.broken:  # a policy file that can't be read hides its deny list: refuse rather than guess
        raise ValueError(f"your unsigned policy can't be used ({rules.broken})")
    grant = read_policy(y.policy) if y.principal.key else None  # no pinned principal: nothing auto-runs
    if grant and y.shared_memory and has_total(grant):
        raise ValueError("the policy has a total limit, which a MemoryStore can only keep when one process "
                         "serves every request (single_process=True)")
    return load_policy(grant, y.service_id, y.principal.key, Tightening(rules.deny, rules.out_of_band))


def described_risk(d: dict) -> Any:
    """A guard's ``describe`` risk: absent means the default, but an explicit None is a value, and
    refused like any unknown risk (as TS refuses null)."""
    if "risk" in d and d["risk"] is None:
        raise ValueError("plan has an unknown risk: None")
    return d.get("risk")


async def described_plans(describe: Callable[[dict], Any], args: dict, apply: Callable[[], Any]) -> list[Plan]:
    """A guarded tool's one plan: what ``describe(args)`` says, applied by running the original."""
    d = await _maybe(describe(args))
    return [Plan(d["summary"], d["effects"], apply=apply, uses=d.get("uses"), risk=described_risk(d),
                 undo_window=d.get("undo_window"))]
