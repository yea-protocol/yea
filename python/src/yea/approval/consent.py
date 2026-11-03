"""Consent codes for clients that can't ask, and the consents `yea approve` stores (SPEC-approval §6)."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from .._json import canonical, sha256_b64url
from ..grants import Grant, GrantContext, consent_code, decode_grant, verify_grant
from ..store import ApprovalStore
from ..uses import check_uses
from .phrase import checked_phrase
from .plan import HashedPlan, plan_preimage
from .policy import Policy

CONSENT_TTL = 600
_NOT_A_CONSENT = "not a consent for this plan"


def consent_hash_of(plan_hash: str, phrase: str) -> str:
    """What a consent grant's ``only`` binds (§6): the plan and the phrase the person typed for
    it, so a consent signed for an edited phrase never matches the server's own."""
    return sha256_b64url(canonical({"plan": plan_hash, "phrase": phrase}).encode())


def job_consent_code(server_key: str, principal: str, input: Any, p: HashedPlan, phrase: str, now: int) -> str:
    """The unsigned ``pc1.`` consent request for one plan. Its detail carries the plan-hash
    preimage (``job``), so ``yea approve`` can re-check the hash, and the phrase to type.
    ``proposal`` is the plan hash; ``hash`` is the consent hash, which binds the phrase."""
    phrase = checked_phrase(phrase)
    consent = {"proposal": p.plan_hash, "hash": consent_hash_of(p.plan_hash, phrase), "service": server_key,
               "capability": p.tool, "principal": principal, "summary": p.plan.summary, "expires": now + CONSENT_TTL}
    job = plan_preimage(p.tool, input, p.plan, p.risk)
    return consent_code(consent, {"job": job, "phrase": phrase})


async def consent_for(plans: list[HashedPlan], store: ApprovalStore, policy: Policy, now: int,
                      phrase_for: Callable[[HashedPlan], str]) -> HashedPlan | None:
    """The first recomputed plan with a valid, unused consent from ``yea approve`` for the phrase
    the tool names now, consuming it by grant id. Denied tools are never run."""
    for p in plans:
        if p.tool in policy.deny:
            continue
        token = await store.get_consent(p.plan_hash)
        check = check_job_consent(token, p, phrase_for(p), policy, now) if token else None
        if check is not None and check.ok and check.id and check.exp is not None and await store.consume_once(check.id, check.exp):
            return p
    return None


@dataclass(frozen=True)
class ConsentCheck:
    ok: bool
    id: str | None = None  # the consent grant's id, which the caller consumes once
    why: str | None = None
    exp: int | None = None


def check_job_consent(token: Any, p: HashedPlan, phrase: str, policy: Policy, now: int) -> ConsentCheck:
    """Whether ``token`` is a consent from ``yea approve`` for exactly this plan and ``phrase``: a
    grant with an ``only`` equal to their consent hash and an ``exp``, signed by the pinned
    principal, issued to this server's key, and valid as a COMMIT of the tool here now. A copied
    policy grant has no ``only`` and never counts."""
    consent_hash = consent_hash_of(p.plan_hash, phrase)
    try:
        g = decode_grant(token) if isinstance(token, str) else None
    except ValueError:
        g = None
    if g is None:
        return ConsentCheck(False, why=_NOT_A_CONSENT)
    # One root block that itself binds the plan. A chain would let the server key delegate the
    # policy grant to itself with an `only` and an `exp`, and approve a plan with no person.
    caveats = g.blocks[0]["p"]["caveats"]
    exp = _expiry(g)
    if len(g.blocks) != 1 or {"only": consent_hash} not in caveats or exp is None:
        return ConsentCheck(False, why=_NOT_A_CONSENT)
    uses = check_uses(p.plan.uses)
    proposal: dict[str, Any] = {"hash": consent_hash, "risk": p.risk, **({"uses": uses} if uses is not None else {})}
    ctx = GrantContext(policy.server_key or "", "COMMIT", p.tool, now, proposal)
    v = verify_grant(g, [policy.principal or ""], policy.server_key or "", ctx)
    return ConsentCheck(True, id=g.id, exp=exp) if v.ok else ConsentCheck(False, why=v.reason)


def _expiry(g: Grant) -> int | None:
    """The earliest ``exp`` in the grant; consents must have one, which bounds a replay."""
    exps = [c["exp"] for b in g.blocks for c in b["p"]["caveats"] if isinstance(c, dict) and type(c.get("exp")) is int]
    return min(exps) if exps else None
