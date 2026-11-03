"""Who is acting, and for whom: a request's verified holder key and the principal of the grant that
lets it act, checked without the ``each``, ``total`` and ``risk`` limits (ADR-0002). Also the check
with those limits, which a COMMIT and an auto INTENT still make here until the commit ledger does
(#279). Like ts/src/service/verified-request/grants.ts and identity.ts."""

from __future__ import annotations

from dataclasses import dataclass, replace

from ...errors import YeaError, fix
from ...grants import Grant, GrantContext, Verification, matches_consent, verify_grant
from ...keys import verify_proof
from ..replies import consent_request
from ..state import ServiceState


@dataclass(frozen=True)
class Scope:
    """What a request is checked for. ``principal``: only grants from this principal (the one a
    proposal was made for) count. ``consent_only``: only a consent grant to ``proposal`` (§6.6)
    counts, and any other that would gets ``consent_required``; set for a proposal with no
    principal, so ``principal`` is None (§4.4)."""

    verb: str
    capability: str
    proposal: dict | None = None
    principal: str | None = None
    consent_only: bool = False


@dataclass(frozen=True)
class Identity:
    """``holder``: the key of the verified proof, or None when the request carried no grants.
    ``principal``: the issuer of the grant that authorized it, or None (anonymous). ``proof``: the
    verified proof, the only one anything after this reads."""

    holder: str | None
    principal: str | None
    proof: dict | None


def identify(state: ServiceState, req: dict, scope: Scope, target: str) -> Identity:
    """The identity of an ASK or INTENT: anonymous is allowed unless the service requires grants. A
    grant that doesn't apply then means anonymous, but its proof is still verified, and its key is
    the holder."""
    if state.require_grants:
        return Identity(*identify_required(state, req, scope, target))
    if not req["grants"]:
        return Identity(None, None, None)
    proof = _verified_proof(state, req["proof"], scope.verb, target)
    granted, _ = first_grant(state, req["grants"], proof["key"], scope, limits=False)
    return Identity(proof["key"], granted.principal if granted else None, proof)


def identify_required(state: ServiceState, req: dict, scope: Scope, target: str) -> tuple[str, str, dict]:
    """The identity of a request that must carry a grant, never anonymous: its holder key, principal
    and verified proof."""
    if not req["grants"]:
        raise YeaError(
            "unauthorized",
            f"{scope.verb} needs a grant from your principal",
            fix=[fix("ask your principal to issue a grant (yea grant) and send it in `grants` with a `proof`")],
        )
    proof = _verified_proof(state, req["proof"], scope.verb, target)
    granted, failed = first_grant(state, req["grants"], proof["key"], scope, limits=False)
    if granted is None:
        raise grant_failure(state, failed, scope.proposal)
    assert granted.principal is not None  # a grant that authorizes has a root, so a principal
    return proof["key"], granted.principal, proof


def with_limits(state: ServiceState, grants: list[str], holder: str, scope: Scope) -> Verification:
    """The grant that authorizes the request with its limits too, or the error that says why none does.
    A scope with no principal (no grant authorized the proposal's INTENT) admits only a consent grant
    to the proposal, from any principal the service trusts (§4.4)."""
    scope = replace(scope, consent_only=scope.principal is None)
    granted, failed = first_grant(state, grants, holder, scope, limits=True)
    if granted is None:
        raise grant_failure(state, failed, scope.proposal)
    return granted


def consenter(state: ServiceState, grants: list[str], holder: str, scope: Scope) -> str | None:
    """The principal a COMMIT of a proposal with no principal acts for, if it carries a consent: the
    issuer of its first consent grant to the proposal, checked without limits (§4.4)."""
    granted, _ = first_grant(state, grants, holder, replace(scope, consent_only=True), limits=False)
    return granted.principal if granted else None


def first_grant(
    state: ServiceState, grants: list[str], holder: str, scope: Scope, *, limits: bool
) -> tuple[Verification | None, list[Verification]]:
    """Try each grant against a proof key already verified: the first that authorizes wins; the rest
    say why not."""
    ctx = GrantContext(
        state.id, scope.verb, scope.capability, state.now(),
        _checked(scope.proposal) if scope.proposal else None,
        state.spent, limits,
    )
    failed = []
    for g in grants:
        c = _screen(verify_grant(g, state.trust, holder, ctx), scope, state.id)
        if c.ok:
            return c, failed
        failed.append(c)
    return None, failed


def _screen(c: Verification, scope: Scope, service: str) -> Verification:
    """A grant's check as the scope sees it at ``service``: failed, even where the grant would
    authorize, when it is from another principal than the proposal's, or isn't the consent the
    proposal needs."""
    if scope.principal and c.principal and c.principal != scope.principal:
        why = "grant is from a different principal than this proposal's"
        return Verification(False, "forbidden", why, c.grant, reason=why)
    if c.ok and scope.consent_only and not _is_consent(c.grant, scope.proposal, service):
        why = "no grant authorized the INTENT that made this proposal"
        return Verification(False, "consent_required", why, c.grant, reason=why)
    return c


def _is_consent(grant: Grant | None, proposal: dict | None, service: str) -> bool:
    """Whether a verified grant is a consent grant to ``proposal`` at ``service`` (§6.6): one root
    block, which its principal signed, with exactly a consent's caveats. A delegated grant never is,
    so an agent can't turn its own grant into one."""
    if grant is None or proposal is None or len(grant.blocks) != 1:
        return False
    return matches_consent(grant.blocks[0]["p"]["caveats"], {**proposal, "service": service})


def grant_failure(state: ServiceState, failed: list[Verification], proposal: dict | None) -> YeaError:
    """The most useful error when no grant authorized: consent, then forbidden, then the first failure."""
    consent = next((c for c in failed if c.code == "consent_required"), None)
    if consent and proposal:
        return YeaError(
            "consent_required",
            f"{_why(consent)}; your principal must approve this exact proposal",
            consent=consent_request(state.id, proposal, consent.principal),
        )
    forbidden = next((c for c in failed if c.code == "forbidden"), None)
    if forbidden:
        return YeaError("forbidden", _why(forbidden), need=forbidden.need)
    return YeaError("unauthorized", _why(failed[0]))


def _verified_proof(state: ServiceState, proof: dict | None, verb: str, target: str) -> dict:
    """The request proof, if it is validly signed over this verb and target; raises otherwise."""
    err = verify_proof(proof, state.id, verb, target, state.now())
    if proof is None or err:
        raise YeaError(
            "unauthorized", err or "missing proof",
            fix=[fix(f'sign {{aud:"{state.id}",verb:"{verb}",target,ts}} with the grant holder key')],
        )
    return proof


def _checked(proposal: dict) -> dict:
    """The parts of a proposal that COMMIT caveats read (§6.3)."""
    out = {"hash": proposal["hash"], "risk": proposal["risk"]}
    if "uses" in proposal:
        out["uses"] = proposal["uses"]
    return out


def _why(c: Verification) -> str:
    """A failed check in the TS core's words (``reason``)."""
    return c.reason or c.message
