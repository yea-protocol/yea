"""Consent: a single-use grant for one exact proposal, and the pc1 code that carries the request (SPEC §6.4)."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from .._json import b64url_decode, b64url_encode, canonical_bytes, loads
from ..keys import KeyPair
from .caveats import _safe_int
from .token import Grant, issue_grant


def consent_grant(principal: KeyPair, agent_key: str, consent: Mapping[str, Any]) -> Grant:
    """The grant a principal signs to approve one ``consent_required`` proposal (§6.6).

    It authorizes exactly one thing: COMMIT of that proposal hash, for that capability, at
    that service, until the proposal expires. Run this in the principal's own tool; an agent
    must never be able to trigger signing with the principal key."""
    return issue_grant(principal, agent_key, [
        {"svc": [consent["service"]]},
        {"verbs": ["COMMIT"]},
        {"can": [consent["capability"]]},
        {"only": consent["hash"]},
        {"exp": consent["expires"]},
    ])


CONSENT_PREFIX = "pc1."
_CONSENT_STR_FIELDS = ("proposal", "hash", "service", "capability", "principal", "summary")


def consent_code(consent: Mapping[str, Any], detail: Mapping[str, Any] | None = None, agent: str | None = None) -> str:
    """Encode a consent request for out-of-band approval: ``pc1.`` + b64url(canonical(c)).

    Pass the proposal the agent received as ``detail`` (``data`` is dropped) so the
    approver can show its real effects and re-check the hash (SPEC §6.6). ``agent`` is the
    key the consent should be issued to, for approving on a machine without that agent's
    key; it is unsigned, so the approver shows it and checks it against a local agent key."""
    body = dict(consent)
    if detail is not None:
        body["detail"] = {k: v for k, v in detail.items() if k != "data"}
    if agent is not None:
        body["agent"] = agent
    return CONSENT_PREFIX + b64url_encode(canonical_bytes(body))


def decode_consent_code(code: str) -> dict:
    """Decode and validate a ``pc1.`` consent code. Raises ValueError."""
    if not isinstance(code, str) or not code.startswith(CONSENT_PREFIX):
        raise ValueError("not a consent code (expected pc1.…)")
    try:
        c = loads(b64url_decode(code[len(CONSENT_PREFIX):]).decode("utf-8"))
    except (ValueError, UnicodeDecodeError) as e:
        raise ValueError(f"consent code is not valid b64url JSON: {e}") from None
    if not isinstance(c, dict):
        raise ValueError("a consent code encodes an object")
    for k in _CONSENT_STR_FIELDS:
        if not isinstance(c.get(k), str):
            raise ValueError(f"consent code missing {k}")
    if not _safe_int(c.get("expires")):
        raise ValueError("consent code missing expires")
    return c
