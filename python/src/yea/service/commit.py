"""COMMIT: committing a proposal once, by the agent that asked for it (SPEC §4.4)."""

from __future__ import annotations

import asyncio

from ..budget import fit
from ..errors import YeaError, fix
from .execute import execute
from .state import ServiceState
from .util import Emit, random_id
from .verified_request import VerifiedCommit


async def on_commit(state: ServiceState, req: VerifiedCommit, emit: Emit) -> dict:
    """``req`` comes from the proposal's requester, under a grant from its principal."""
    proposal = req.stored.proposal
    pid = proposal["id"]
    existing = state.commits.get(pid)
    if existing is not None:
        # Idempotent replay (§4.4): limits already spent don't block it.
        prior = await asyncio.shield(existing)
        stored_receipt = state.receipts.get(prior["receipt"]["id"]) if prior["kind"] == "RECEIPT" else None
        if prior["kind"] == "RECEIPT" and (stored_receipt is None or stored_receipt.principal != req.principal):
            raise YeaError("forbidden", "this proposal was committed by a different principal")
        return {**prior, "id": random_id("s"), "re": req.id, **({"replay": True} if prior["kind"] == "RECEIPT" else {})}
    auth = req.limits()
    if state.now() >= proposal["expires"]:
        raise YeaError("expired", "this proposal has expired", fix=[fix("send INTENT again to get a fresh proposal")])
    out = await execute(state, pid, auth, req.id, emit)
    return fit(out, req.budget, state.handles, req.holder) if out["kind"] == "RECEIPT" else out
