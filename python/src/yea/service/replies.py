"""Building reply frames: the frame itself, error replies, the unknown-capability error, and reading a request's
params and verified key."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any

from ..errors import YeaError, fix
from ..validate import closest
from .util import _json_str, random_id

if TYPE_CHECKING:
    from . import Service

log = logging.getLogger("yea")


def reply_frame(re: str, kind: str, body: dict) -> dict:
    return {"yea": 1, "id": random_id("s"), "re": re, "kind": kind, **body}


def error_reply(re: str, e: BaseException) -> dict:
    if isinstance(e, YeaError):
        return reply_frame(re, "ERROR", e.body())
    log.exception("handler failed", exc_info=e)
    return reply_frame(re, "ERROR", {"code": "internal", "message": "the service failed unexpectedly", "retry": 5})


def unknown_capability(svc: Service, name: Any, kind: str) -> YeaError:
    other = svc._intents if kind == "ask" else svc._asks
    if isinstance(name, str) and name in other:
        verb = "INTENT" if kind == "ask" else "ASK"
        return YeaError(
            "unknown_capability", f"{name} is {'an intent' if kind == 'ask' else 'an ask'} capability", fix=[fix(f"send it with {verb}")]
        )
    everything = [*svc._asks, *svc._intents]
    near = closest(str(name), everything)
    return YeaError(
        "unknown_capability",
        f"no capability named {_json_str(name)}",
        fix=[fix(f"did you mean {near}?")] if near else [fix(f"send HELLO to list capabilities ({len(everything)} available)")],
    )


def params_of(frame: dict) -> dict:
    params = frame.get("params")
    if params is None:
        return {}
    if not isinstance(params, dict):
        raise YeaError("invalid_params", "`params` must be an object")
    return params


def request_grants(frame: dict) -> list[str]:
    """A request's grants (SPEC §3). Only a missing, null or empty ``grants`` is none; anything
    else must be a list of strings, or the request is a ``bad_frame``."""
    grants = frame.get("grants")
    if grants is None:
        return []
    if not isinstance(grants, list) or not all(isinstance(g, str) for g in grants):
        raise YeaError("bad_frame", "`grants` must be a list of strings")
    return grants


def verified_key(frame: dict) -> str | None:
    """The proof key of a request whose proof ``authorize`` verified: it verifies the proof
    whenever ``request_grants`` finds grants, and rejects the request otherwise. Call it only
    after ``authorize``."""
    return frame["proof"]["key"] if request_grants(frame) else None
