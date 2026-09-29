"""EXPAND: the rest of an elided reply, for the key it was made for (SPEC §8)."""

from __future__ import annotations

from ..budget import fit
from ..errors import YeaError, fix
from ..keys import verify_proof
from .replies import reply_frame
from .state import ServiceState
from .util import _json_str


def on_expand(state: ServiceState, frame: dict, budget: int) -> dict:
    h = frame.get("handle")
    parked = state.handles.get(h) if isinstance(h, str) else None
    if parked is None:
        raise YeaError("expired", f"handle {_json_str(h)} is unknown or expired", fix=[fix("repeat the original request")])
    value, owner = parked
    if owner:  # handles from authenticated replies expand only for the same holder key (§4.6)
        proof = frame.get("proof")
        if verify_proof(proof, state.id, "EXPAND", h, state.now()) or proof["key"] != owner:
            raise YeaError("unauthorized", "this handle belongs to another agent",
                           fix=[fix("expand it with the same key that made the original request")])
    elif state.require_grants:
        raise YeaError("unauthorized", "EXPAND needs a grant from your principal")
    data = {"items": value} if isinstance(value, list) else {"text": value}
    return fit(reply_frame(frame["id"], "ANSWER", {"data": data}), budget, state.handles, owner)
