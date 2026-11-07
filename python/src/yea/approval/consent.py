"""Consent codes for clients that can't ask, and the consents `yea approve` stores (SPEC-approval §6)."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from .._json import MAX_SAFE_INT, canonical, sha256_b64url
from ..grants import Grant, GrantContext, consent_code, decode_grant, verify_grant
from ..store import ApprovalStore
from ..uses import check_uses
from .phrase import checked_phrase, effective_phrase
from .plan import HashedPlan, plan_preimage
from .policy import Policy

CONSENT_TTL = 600
# A consent that isn't shaped like one (§6).
NOT_A_CONSENT = "not a consent for this plan"
# A consent the principal signed, validly, for another phrase: the tool's phrase changed, or the
# code the person approved was edited (§6).
OTHER_PHRASE = "not a consent for this phrase"
# What the person is told when a stored consent was signed for a different phrase.
PHRASE_CHANGED = ("a consent for this plan was signed for a different phrase; approve the new code — "
                  "if this repeats, the code you were given may have been altered")


def consent_hash_of(plan_hash: str, phrase: str) -> str:
    """What a consent grant's ``only`` binds (§6): the plan and the phrase the tool names for it,
    after the ``approve`` fallback, so a consent signed for an edited phrase never matches the
    server's own."""
    return sha256_b64url(canonical({"plan": plan_hash, "phrase": effective_phrase(phrase)}).encode())


def job_consent_code(server_key: str, principal: str, input: Any, p: HashedPlan, phrase: str, now: int) -> str:
    """The unsigned ``pc1.`` consent request for one plan. Its detail carries the plan-hash
    preimage (``job``), so ``yea approve`` can re-check the hash, and the phrase to type.
    ``proposal`` is the plan hash; ``hash`` is the consent hash, which binds the phrase."""
    phrase = checked_phrase(phrase)
    consent = {"proposal": p.plan_hash, "hash": consent_hash_of(p.plan_hash, phrase), "service": server_key,
               "capability": p.tool, "principal": principal, "summary": p.plan.summary, "expires": now + CONSENT_TTL}
    job = plan_preimage(p.tool, input, p.plan, p.risk)
    return consent_code(consent, {"job": job, "phrase": phrase})


@dataclass(frozen=True)
class StoredConsent:
    """The plan a stored consent runs, if any, and what to tell the person when none does."""
    plan: HashedPlan | None = None
    note: str | None = None  # PHRASE_CHANGED when a consent was signed for a different phrase


async def consent_for(plans: list[HashedPlan], store: ApprovalStore, policy: Policy, now: int,
                      phrase_for: Callable[[HashedPlan], str]) -> StoredConsent:
    """The first recomputed plan with a valid, unused consent from ``yea approve`` for the phrase
    the tool names now, consuming it by grant id. Denied tools are never run. One that is
    consumed, expired or failing counts as absent, but one signed for a different phrase leaves a
    note, so a changed phrase or an edited code isn't silent."""
    note = None
    for p in plans:
        if p.tool in policy.deny:
            continue
        token = await store.get_consent(p.plan_hash)
        check = check_job_consent(token, p, phrase_for(p), policy, now) if token else None
        if check is not None and check.ok and check.id and check.exp is not None and await store.consume_once(check.id, check.exp):
            return StoredConsent(plan=p)
        if check is not None and check.why == OTHER_PHRASE:
            note = note or PHRASE_CHANGED
    return StoredConsent(note=note)


@dataclass(frozen=True)
class ConsentCheck:
    ok: bool
    id: str | None = None  # the consent grant's id, which the caller consumes once
    why: str | None = None
    exp: int | None = None


def check_job_consent(token: Any, p: HashedPlan, phrase: str, policy: Policy, now: int) -> ConsentCheck:
    """Whether ``token``, a consent from ``yea approve`` in the store or on the call, may run exactly
    this plan with ``phrase``: a grant with an ``only`` equal to their consent hash and an ``exp``,
    signed by the pinned principal, issued to this server's key, and valid as a COMMIT of the tool
    here now. A copied policy grant isn't shaped like a consent. One that is valid but binds another
    hash is refused with ``OTHER_PHRASE``, so the caller can say why."""
    g = _decoded(token)
    bound = _bound_hash(g) if g is not None else None
    exp = _expiry(g) if g is not None else None
    if g is None or bound is None or exp is None:
        return ConsentCheck(False, why=NOT_A_CONSENT)
    # Checked against the hash it binds, so a valid consent for another phrase is told apart.
    uses = check_uses(p.plan.uses)
    proposal: dict[str, Any] = {"hash": bound, "risk": p.risk, **({"uses": uses} if uses is not None else {})}
    ctx = GrantContext(policy.server_key or "", "COMMIT", p.tool, now, proposal)
    v = verify_grant(g, [policy.principal or ""], policy.server_key or "", ctx)
    if not v.ok:
        return ConsentCheck(False, why=v.reason)
    if bound != consent_hash_of(p.plan_hash, phrase):
        return ConsentCheck(False, why=OTHER_PHRASE)
    return ConsentCheck(True, id=g.id, exp=exp)


def consent_expiry(token: Any) -> int | None:
    """When a consent grant expires: its earliest ``exp``, read without checking anything else, or
    None if it isn't shaped like a consent. To tell an expired consent from a forged one when the
    grant check fails (§6)."""
    g = _decoded(token)
    return _expiry(g) if g is not None and _bound_hash(g) is not None else None


def _decoded(token: Any) -> Grant | None:
    try:
        return decode_grant(token) if isinstance(token, str) else None
    except ValueError:
        return None


def _bound_hash(g: Grant) -> str | None:
    """The hash a consent binds: the ``only`` of its one root block. A chain would let the server
    key delegate the policy grant to itself with an ``only`` and an ``exp``, and approve a plan
    with no person, so a consent is a single block."""
    if len(g.blocks) != 1:
        return None
    only = next((c["only"] for c in g.blocks[0]["p"]["caveats"] if isinstance(c, dict) and "only" in c), None)
    return only if isinstance(only, str) else None


def _expiry(g: Grant) -> int | None:
    """The earliest ``exp`` in the grant; consents must have one, which bounds a replay. Only a safe
    integer counts, as in TypeScript, so both languages agree on what is shaped like a consent."""
    exps = [c["exp"] for b in g.blocks for c in b["p"]["caveats"] if isinstance(c, dict) and _safe_int(c.get("exp"))]
    return min(exps) if exps else None


def _safe_int(v: Any) -> bool:
    return type(v) is int and abs(v) <= MAX_SAFE_INT
