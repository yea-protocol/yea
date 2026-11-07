"""UNDO (SPEC §4.5): the commit ledger reverts the receipt's plan once, inside its undo window."""

from __future__ import annotations

from ..budget import fit
from .commit_ledger import Undo
from .state import ServiceState
from .util import Emit
from .verified_request import VerifiedUndo


async def on_undo(state: ServiceState, req: VerifiedUndo, emit: Emit) -> dict:
    """``req`` names an undoable receipt, under a grant from the principal who committed it."""
    out = await state.ledger.undo(Undo(req.id, req.stored, req.principal), emit)
    return fit(out, req.budget, state.handles, req.holder) if out["kind"] == "RECEIPT" else out
