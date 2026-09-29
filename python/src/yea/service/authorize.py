"""Checking a request's grants and proof, and the consent request when a commit needs the person (SPEC §6)."""

from __future__ import annotations

from ..errors import YeaError, fix
from ..grants import GrantContext, Verification, verify_grant
from ..keys import verify_proof
from .state import ServiceState


def _checked(proposal: dict) -> dict:
    """The parts of a proposal that COMMIT caveats read (§6.3)."""
    out = {"hash": proposal["hash"], "risk": proposal["risk"]}
    if "uses" in proposal:
        out["uses"] = proposal["uses"]
    return out


def consent_request(state: ServiceState, proposal: dict, principal: str | None) -> dict:
    return {
        "proposal": proposal["id"], "hash": proposal["hash"], "service": state.id,
        "capability": proposal["capability"], "principal": principal,
        "summary": proposal["summary"], "expires": proposal["expires"],
    }


async def authorize(
    state: ServiceState, frame: dict, verb: str, capability: str, target: str, proposal: dict | None = None,
    *, principal: str | None = None, replay: bool = False,
) -> Verification | None:
    """Verify grants and proof. ``principal``: only grants from this principal count (the
    one a proposal was made for). ``replay``: ``each``, ``total`` and risk were already checked by
    the original commit, so ``consent_required`` counts as authorized (§4.4)."""
    grants = request_grants(frame)
    required = verb in ("COMMIT", "UNDO") or state.require_grants
    if not grants:
        if required:
            raise YeaError(
                "unauthorized",
                f"{verb} needs a grant from your principal",
                fix=[fix("ask your principal to issue a grant (yea grant) and send it in `grants` with a `proof`")],
            )
        return None
    now = state.now()
    err = verify_proof(frame.get("proof"), state.id, verb, target, now)
    if err:
        raise YeaError(
            "unauthorized", err, fix=[fix(f'sign {{aud:"{state.id}",verb:"{verb}",target,ts}} with the grant holder key')]
        )
    ctx = GrantContext(
        state.id, verb, capability, now,
        _checked(proposal) if proposal else None,
        state.spent,
    )
    checks = []
    for g in grants:
        c = verify_grant(g, state.trust, frame["proof"]["key"], ctx)
        if principal and c.principal and c.principal != principal:
            why = "grant is from a different principal than this proposal's"
            checks.append(Verification(False, "forbidden", why, c.grant, reason=why))
            continue
        if c.ok:
            return c
        if replay and c.code == "consent_required":
            return Verification(True, grant=c.grant)
        checks.append(c)
    if not required:
        return None  # a grant that doesn't apply to ASK/INTENT just means "anonymous"
    consent = next((c for c in checks if c.code == "consent_required"), None)
    if consent and proposal:
        raise YeaError(
            "consent_required",
            f"{_why(consent)}; your principal must approve this exact proposal",
            consent=consent_request(state, proposal, consent.principal),
        )
    forbidden = next((c for c in checks if c.code == "forbidden"), None)
    if forbidden:
        raise YeaError("forbidden", _why(forbidden), need=forbidden.need)
    raise YeaError("unauthorized", _why(checks[0]))


def _why(c: Verification) -> str:
    """A failed check in the TS core's words (``reason``)."""
    return c.reason or c.message


def request_grants(frame: dict) -> list[str]:
    """A request's grants (SPEC §3). Only a missing, null or empty ``grants`` is none; anything
    else must be a list of strings, or the request is a ``bad_frame``."""
    grants = frame.get("grants")
    if grants is None:
        return []
    if not isinstance(grants, list) or not all(isinstance(g, str) for g in grants):
        raise YeaError("bad_frame", "`grants` must be a list of strings")
    return grants


def verified_key(frame: dict) -> str | None:
    """The proof key of a request whose proof ``authorize`` verified: it verifies the proof
    whenever ``request_grants`` finds grants, and rejects the request otherwise. Call it only
    after ``authorize``."""
    return frame["proof"]["key"] if request_grants(frame) else None
