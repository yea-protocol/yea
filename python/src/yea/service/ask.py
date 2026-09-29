"""ASK: a read-only capability, fitted to the agent's budget (SPEC §4.2)."""

from __future__ import annotations

from typing import TYPE_CHECKING

from ..budget import fit
from ..validate import validate_params
from .authorize import authorize
from .plan import Ctx
from .replies import params_of, reply_frame, unknown_capability, verified_key
from .util import _call

if TYPE_CHECKING:
    from . import Service


async def on_ask(svc: Service, frame: dict, budget: int) -> dict:
    name = frame.get("capability")
    d = svc._asks.get(name) if isinstance(name, str) else None
    if d is None:
        raise unknown_capability(svc, name, "ask")
    params = params_of(frame)
    validate_params(d.params, params)
    auth = await authorize(svc, frame, "ASK", name, name)
    data = await _call(d.run, Ctx(params, auth.principal if auth else None))
    return fit(reply_frame(frame["id"], "ANSWER", {"data": data}), budget, svc.handles, verified_key(frame))
