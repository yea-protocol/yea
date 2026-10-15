"""The verified request (GLOSSARY.md): an untrusted frame, read for its verb, with what it names
looked up and its proof and grants checked. It says who is acting (the holder), for whom (the
principal) and, for a COMMIT, from which requester. Handlers get this, never the raw frame.

It checks every caveat but ``each``, ``total`` and ``risk`` (ADR-0002). Until #279 moves them to the
commit ledger, a COMMIT's ``limits()`` and an auto INTENT's ``auto.grant()`` check those here. Like
ts/src/service/verified-request.ts."""

from __future__ import annotations

from typing import Any

from ..state import ServiceState
from .parse import parse_request
from .verbs import (
    AutoCommit,
    VerifiedAsk,
    VerifiedCommit,
    VerifiedExpand,
    VerifiedHello,
    VerifiedIntent,
    VerifiedUndo,
    verify_ask,
    verify_commit,
    verify_expand,
    verify_intent,
    verify_undo,
)

VerifiedRequest = VerifiedHello | VerifiedAsk | VerifiedIntent | VerifiedCommit | VerifiedUndo | VerifiedExpand

_VERIFY = {
    "ASK": verify_ask,
    "INTENT": verify_intent,
    "COMMIT": verify_commit,
    "UNDO": verify_undo,
    "EXPAND": verify_expand,
}


def verify_request(state: ServiceState, frame: Any, default_budget: int) -> VerifiedRequest:
    """Read a request frame and verify it for its verb. ``budget`` is the frame's, or
    ``default_budget``. Raises the error to reply with: ``bad_frame`` or ``invalid_params`` from the
    frame alone, then what a lookup or the grant check finds."""
    req = parse_request(frame)
    budget = req["budget"] or default_budget
    if req["verb"] == "HELLO":
        return VerifiedHello(req["id"], budget)
    return _VERIFY[req["verb"]](state, req, budget)


__all__ = [
    "AutoCommit",
    "VerifiedAsk",
    "VerifiedCommit",
    "VerifiedExpand",
    "VerifiedHello",
    "VerifiedIntent",
    "VerifiedRequest",
    "VerifiedUndo",
    "parse_request",
    "verify_request",
]
