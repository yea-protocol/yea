"""Building reply frames: the frame itself, error replies, and the consent request a commit over its
limits carries (SPEC §6.6)."""

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


def consent_request(service: str, proposal: dict, principal: str | None) -> dict:
    return {
        "proposal": proposal["id"], "hash": proposal["hash"], "service": service,
        "capability": proposal["capability"], "principal": principal,
        "summary": proposal["summary"], "expires": proposal["expires"],
    }
