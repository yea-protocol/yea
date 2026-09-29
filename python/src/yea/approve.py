"""What an approver's tooling checks and shows before a person consents (SPEC §6.6). Mirrors
ts/src/approve.ts: the consent request must name the proposal the agent actually received, and
that proposal must be well formed and hash to its hash; what the person reads is re-rendered
from the proposal's fields with every line escaped, never the service's summary alone."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from ._json import CanonicalError, proposal_hash
from .lens import untrusted_lens
from .lens.depth import too_deep_to_approve
from .risk import is_risk
from .text import printable
from .uses import is_uses


def check_proposal(p: Mapping[str, Any]) -> str | None:
    """Why a proposal can't be bound by a consent, or None if it can (SPEC §5.1, §6.6): its ``uses``
    well formed, its ``risk`` known, its bound fields shallow enough to show in full, and it hashes to
    its ``hash`` (an unhashable one can't)."""
    if "uses" in p and not is_uses(p["uses"]):
        return "the proposal has a malformed uses"
    if not is_risk(p.get("risk")):
        return "the proposal has an unknown risk"
    if too_deep_to_approve({k: v for k, v in p.items() if k != "data"}):
        return "the proposal is nested too deep to show in full"
    try:
        if proposal_hash(p) == p.get("hash"):
            return None
    except (CanonicalError, ValueError, TypeError, RecursionError):
        pass  # unhashable: refused like any other mismatch
    return "the proposal doesn't match its hash"


def consent_request_problem(k: Mapping[str, Any], p: Mapping[str, Any], service: str | None = None) -> str | None:
    """Why consent request ``k`` can't be shown for signing against ``p``, the proposal the agent
    got from the service; None when it can. ``service`` is where ``p`` came from, when known."""
    checks = [
        (k.get("proposal") != p.get("id"), "the consent request names another proposal"),
        (k.get("hash") != p.get("hash"), "the consent request's hash isn't the proposal's"),
        (k.get("capability") != p.get("capability"), "the consent request names another capability"),
        (service is not None and k.get("service") != service, "the consent request names another service"),
    ]
    return next((why for bad, why in checks if bad), None) or check_proposal(p)


def check_consent(consent: Mapping[str, Any], proposal: Mapping[str, Any], service: str | None = None) -> None:
    """What an approver's tooling MUST check before showing a consent request: raises ValueError
    with the reason on any problem (``consent_request_problem``). Pass ``service`` whenever you
    know where the proposal came from; without it the service claim isn't checked."""
    why = consent_request_problem(consent, proposal, service)
    if why:
        raise ValueError(why)


def consent_view(p: Mapping[str, Any]) -> list[str]:
    """The proposal as a person reads it before consenting: summary, effects, uses, risk, undo
    and expiry, re-rendered from its fields (``data`` left out: the hash doesn't cover it), with
    every line through ``printable``."""
    bound = {k: v for k, v in p.items() if k != "data"}
    rendered = untrusted_lens({"yea": 1, "id": "-", "re": "-", "kind": "PROPOSALS", "proposals": [bound]})
    return [printable(line) for line in rendered.split("\n")[1:]]


def consent_lines(k: Mapping[str, Any], p: Mapping[str, Any], service: str | None = None) -> dict[str, Any]:
    """``{"lines": [...]}`` to show a person asked to consent to ``k``, or ``{"why": ...}`` when it
    must not be shown. There's no view without the proposal: the summary alone never suffices."""
    why = consent_request_problem(k, p, service)
    if why:
        return {"why": why}
    return {"lines": [f"at {printable(str(k.get('service', '')))}:", *consent_view(p)]}


def consent_from(k: Mapping[str, Any], p: Mapping[str, Any]) -> dict:
    """The consent request to sign for ``p``, built from the proposal rather than the service's
    request: only the service and principal come from ``k``; the expiry is the earlier of the two.
    Call it only after ``check_consent(k, p)`` passes."""
    return {"proposal": p["id"], "hash": p["hash"], "service": k["service"], "capability": p["capability"],
            "principal": k["principal"], "summary": p["summary"], "expires": min(k["expires"], p["expires"])}
