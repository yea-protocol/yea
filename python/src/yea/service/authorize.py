"""Checking a request's grants and proof, and the consent request when a commit needs the person (SPEC §6)."""

from __future__ import annotations

from typing import TYPE_CHECKING

from ..errors import YeaError, fix
from ..grants import GrantContext, Verification, verify_grant
from ..keys import verify_proof

if TYPE_CHECKING:
    from . import Service


def _checked(proposal: dict) -> dict:
    """The parts of a proposal that COMMIT caveats read (§6.3)."""
    out = {"hash": proposal["hash"], "risk": proposal["risk"]}
    if "uses" in proposal:
        out["uses"] = proposal["uses"]
    return out


def consent_request(svc: Service, proposal: dict, principal: str | None) -> dict:
    return {
        "proposal": proposal["id"], "hash": proposal["hash"], "service": svc.id,
        "capability": proposal["capability"], "principal": principal,
        "summary": proposal["summary"], "expires": proposal["expires"],
    }


async def authorize(
    svc: Service, frame: dict, verb: str, capability: str, target: str, proposal: dict | None = None,
    *, principal: str | None = None, replay: bool = False,
) -> Verification | None:
    """Verify grants and proof. ``principal``: only grants from this principal count (the
    one a proposal was made for). ``replay``: ``each``, ``total`` and risk were already checked by
    the original commit, so ``consent_required`` counts as authorized (§4.4)."""
    grants = frame.get("grants") or []
    required = verb in ("COMMIT", "UNDO") or svc.require_grants
    if not grants:
        if required:
            raise YeaError(
                "unauthorized",
                f"{verb} needs a grant from your principal",
                fix=[fix("ask your principal to issue a grant (yea grant) and send it in `grants` with a `proof`")],
            )
        return None
    if not isinstance(grants, list) or not all(isinstance(g, str) for g in grants):
        raise YeaError("bad_frame", "`grants` must be a list of strings")
    now = svc.now()
    err = verify_proof(frame.get("proof"), svc.id, verb, target, now)
    if err:
        raise YeaError(
            "unauthorized", err, fix=[fix(f'sign {{aud:"{svc.id}",verb:"{verb}",target,ts}} with the grant holder key')]
        )
    ctx = GrantContext(
        svc.id, verb, capability, now,
        _checked(proposal) if proposal else None,
        svc._spent,
    )
    checks = []
    for g in grants:
        c = verify_grant(g, svc.trust, frame["proof"]["key"], ctx)
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
            consent=consent_request(svc, proposal, consent.principal),
        )
    forbidden = next((c for c in checks if c.code == "forbidden"), None)
    if forbidden:
        raise YeaError("forbidden", _why(forbidden), need=forbidden.need)
    raise YeaError("unauthorized", _why(checks[0]))


def _why(c: Verification) -> str:
    """A failed check in the TS core's words (``reason``)."""
    return c.reason or c.message
