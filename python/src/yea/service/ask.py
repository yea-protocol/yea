"""ASK: a read-only capability, fitted to the agent's budget (SPEC §4.2)."""

from __future__ import annotations

from ..budget import fit
from ..validate import validate_params
from .authorize import authorize, verified_key
from .capabilities import unknown_capability
from .plan import Ctx
from .replies import params_of, reply_frame
from .state import ServiceState
from .util import _call


async def on_ask(state: ServiceState, frame: dict, budget: int) -> dict:
    name = frame.get("capability")
    d = state.asks.get(name) if isinstance(name, str) else None
    if d is None:
        raise unknown_capability(state, name, "ask")
    params = params_of(frame)
    validate_params(d.params, params)
    auth = await authorize(state, frame, "ASK", name, name)
    data = await _call(d.run, Ctx(params, auth.principal if auth else None))
    return fit(reply_frame(frame["id"], "ANSWER", {"data": data}), budget, state.handles, verified_key(frame))
