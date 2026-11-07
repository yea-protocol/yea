"""COMMIT (SPEC §4.4): the commit ledger commits the proposal once; repeats get the original outcome."""

from __future__ import annotations

from ..budget import fit
from .commit_ledger import Commit
from .state import ServiceState
from .util import Emit
from .verified_request import VerifiedCommit


async def on_commit(state: ServiceState, req: VerifiedCommit, emit: Emit) -> dict:
    """``req`` comes from the proposal's requester, under a grant from its principal."""
    out = await state.ledger.commit(Commit(req.id, req.stored, req.principal, req.admit), emit)
    return fit(out, req.budget, state.handles, req.holder) if out["kind"] == "RECEIPT" else out
