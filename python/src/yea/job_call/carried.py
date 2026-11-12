"""A consent on the call (SPEC-approval §6): the one ``yea approve`` printed, passed back as
``yea_consent``. It's checked and consumed exactly as a stored consent, so it runs at most once
whichever way it arrived. One that approves no plan runs nothing: the call asks again and says why,
and never falls through to a stored consent or the policy."""

from __future__ import annotations

from ..approval import NOT_A_CONSENT, OTHER_PHRASE, HashedPlan, check_job_consent, job_consent_expiry, strip_phrase_edge
from .ask import ask
from .outcome import Outcome, Round

# Why a consent on the call ran nothing: fixed text, so both languages say the same (§6).
_NOT_CONSENT = "it isn't a consent from yea approve"
_EXPIRED = "it has expired"
_NOT_SIGNED = "it isn't signed by the pinned principal for this tool at this server"
_NO_PLAN = ("it approves none of these plans; if the person approved this exact request, this server may have "
            "restarted since or not be the one that asked, or the code they were given may have been altered")
_USED = "it was already used"


def _refused_why(token: str, why: str | None, now: int) -> str:
    """Why the grant check refused a consent: expired, or anything else it could be."""
    if why == NOT_A_CONSENT:
        return _NOT_CONSENT
    exp = job_consent_expiry(token)
    return _EXPIRED if exp is not None and exp <= now else _NOT_SIGNED


async def _approved_by(r: Round, token: str) -> HashedPlan | str:
    """The plan a consent on the call runs, consumed by its grant id; or why it runs none."""
    call = r.call
    if not call.policy.principal:
        return call.unpinned or "no principal key is pinned"
    for p in r.plans:
        check = check_job_consent(token, p, r.phrase_for(p), r.store_id, call.policy, call.now)
        if check.ok and check.id is not None and check.exp is not None:
            return p if await r.store.consume_once(check.id, check.exp) else _USED
        # Only the hash it binds differs from plan to plan; any other refusal is the same for all.
        # So reaching the end means it binds none of them: another plan, phrase or store, or an
        # edited code, which the person may want to know about (§6).
        if check.why != OTHER_PHRASE:
            return _refused_why(token, check.why, call.now)
    return _NO_PLAN


async def carried_round(r: Round, token: str) -> Outcome:
    """A first round that carries a consent: it runs the plan it approves, or the call asks again.
    The edge set a typed phrase loses (§3) is stripped first, so the newline a terminal copy adds
    doesn't matter: the signature covers nothing outside the ``pg1.`` token."""
    approved = await _approved_by(r, strip_phrase_edge(token))
    if isinstance(approved, HashedPlan):
        return Outcome("run", plan=approved, how="approved")
    return ask(r, f"the consent passed as yea_consent can't be used: {approved}", 1)
