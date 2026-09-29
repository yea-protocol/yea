"""Building reply frames: the frame itself and error replies, and reading a request's params."""

from __future__ import annotations

import logging

from ..errors import YeaError
from .util import random_id

log = logging.getLogger("yea")


def reply_frame(re: str, kind: str, body: dict) -> dict:
    return {"yea": 1, "id": random_id("s"), "re": re, "kind": kind, **body}


def error_reply(re: str, e: BaseException) -> dict:
    if isinstance(e, YeaError):
        return reply_frame(re, "ERROR", e.body())
    log.exception("handler failed", exc_info=e)
    return reply_frame(re, "ERROR", {"code": "internal", "message": "the service failed unexpectedly", "retry": 5})


def params_of(frame: dict) -> dict:
    params = frame.get("params")
    if params is None:
        return {}
    if not isinstance(params, dict):
        raise YeaError("invalid_params", "`params` must be an object")
    return params
