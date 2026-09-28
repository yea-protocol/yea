"""COMMIT: committing a proposal once, by the agent that asked for it (SPEC §4.4)."""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING

from ..budget import fit
from ..errors import YeaError, fix
from .authorize import authorize
from .execute import execute
from .records import _StoredProposal
from .util import Emit, _json_str, random_id

if TYPE_CHECKING:
    from . import Service


def check_requester(stored: _StoredProposal, frame: dict) -> None:
    """Only the agent that asked for a proposal (with a verified proof) may commit it (§4.4)."""
    if stored.requester is None:
        raise YeaError("forbidden", "this proposal came from an anonymous INTENT and can't be committed",
                       fix=[fix("send INTENT again with your grant, then commit that proposal")])
    if stored.requester != frame["proof"]["key"]:
        raise YeaError("forbidden", "only the agent that requested this proposal can commit it",
                       fix=[fix("send INTENT yourself, then commit your own proposal")])


async def on_commit(svc: Service, frame: dict, budget: int, emit: Emit) -> dict:
    pid = frame.get("proposal")
    stored = svc._proposals.get(pid) if isinstance(pid, str) else None
    if stored is None:
        raise YeaError("not_found", f"no proposal {_json_str(pid)}", fix=[fix("send INTENT again to get fresh proposals")])
    proposal = stored.proposal
    if frame.get("hash") != proposal["hash"]:
        # Never reveal the right hash: the agent must commit what it actually read.
        raise YeaError(
            "conflict",
            "hash does not match the proposal; you would commit something other than what you saw",
            fix=[fix("re-read the proposal, or send INTENT again")],
        )
    existing = svc._commits.get(pid)
    if existing is not None:
        auth = await authorize(svc, frame, "COMMIT", proposal["capability"], proposal["hash"], proposal,
                                principal=stored.principal, replay=True)
        assert auth is not None
        check_requester(stored, frame)
        prior = await asyncio.shield(existing)
        if prior["kind"] == "RECEIPT" and svc._receipts[prior["receipt"]["id"]].principal != auth.principal:
            raise YeaError("forbidden", "this proposal was committed by a different principal")
        return {**prior, "id": random_id("s"), "re": frame["id"], **({"replay": True} if prior["kind"] == "RECEIPT" else {})}
    auth = await authorize(svc, frame, "COMMIT", proposal["capability"], proposal["hash"], proposal,
                           principal=stored.principal)
    assert auth is not None
    check_requester(stored, frame)
    if svc.now() >= proposal["expires"]:
        raise YeaError("expired", "this proposal has expired", fix=[fix("send INTENT again to get a fresh proposal")])
    out = await execute(svc, pid, auth, frame["id"], emit)
    return fit(out, budget, svc.handles, frame["proof"]["key"]) if out["kind"] == "RECEIPT" else out
