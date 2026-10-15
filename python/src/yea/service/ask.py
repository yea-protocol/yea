"""ASK: a read-only capability, fitted to the agent's budget (SPEC §4.2)."""

from __future__ import annotations

from ..budget import fit
from .plan import Ctx
from .replies import reply_frame
from .state import ServiceState
from .util import _call
from .verified_request import VerifiedAsk


async def on_ask(state: ServiceState, req: VerifiedAsk) -> dict:
    data = await _call(req.d.run, Ctx(req.params, req.principal))
    return fit(reply_frame(req.id, "ANSWER", {"data": data}), req.budget, state.handles, req.holder)
