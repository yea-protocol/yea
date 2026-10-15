"""EXPAND: the rest of an elided reply, for the key it was made for (SPEC §8)."""

from __future__ import annotations

from ..budget import fit
from .replies import reply_frame
from .state import ServiceState
from .verified_request import VerifiedExpand


def on_expand(state: ServiceState, req: VerifiedExpand) -> dict:
    data = {"items": req.value} if isinstance(req.value, list) else {"text": req.value}
    return fit(reply_frame(req.id, "ANSWER", {"data": data}), req.budget, state.handles, req.owner)
