"""The request state that goes round the client, and how a returned one is checked (SPEC-approval §4)."""

from __future__ import annotations

import secrets
from typing import Any

from .._json import b64url_encode


STATE_TTL = 600  # seconds; no later than the MCP SDK's own request-state lifetime


MAX_ROUNDS = 3


def new_state(tool: str, input_hash: str, sub: str, plans: list[str], round: int, now: int) -> dict:
    """The requestState plaintext: hashes, a counter and a nonce only."""
    return {"v": 1, "tool": tool, "inputHash": input_hash, "sub": sub, "plans": list(plans),
            "round": round, "nonce": b64url_encode(secrets.token_bytes(16)), "exp": now + STATE_TTL}


BAD_STATE = "this approval is invalid or has expired; call the tool again"


def check_state(state: Any, tool: str, input_hash: str, sub: str, now: int) -> dict | None:
    """The state if it can be used for this call, else None. Callers refuse every failure with
    the same message (``BAD_STATE``)."""
    ok = (
        isinstance(state, dict) and state.get("v") == 1 and state.get("tool") == tool
        and state.get("inputHash") == input_hash and state.get("sub") == sub
        and isinstance(state.get("plans"), list) and all(isinstance(h, str) for h in state["plans"])
        and type(state.get("round")) is int and 1 <= state["round"] <= MAX_ROUNDS
        and isinstance(state.get("nonce"), str) and type(state.get("exp")) is int and now < state["exp"]
    )
    return state if ok else None
