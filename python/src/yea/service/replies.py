"""Building reply frames: the frame itself, error replies, replays, EVENTs, and the consent request a
commit over its limits carries (SPEC §6.6). Like ts/src/service/replies.ts."""

from __future__ import annotations

import logging
from typing import Any

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


def replay_of(prior: dict, re: str) -> dict:
    """A prior reply re-issued for a repeated request: a repeated COMMIT or UNDO, or an auto INTENT
    (§4.3.1). It is a new frame, so it gets a fresh id (§2.1); a receipt is marked ``replay``."""
    return {**prior, "id": random_id("s"), "re": re, **({"replay": True} if prior["kind"] == "RECEIPT" else {})}


def event_frame(re: str, message: str, progress: float | None = None, data: Any = None) -> dict:
    """An EVENT on the frame ``re``, with ``progress`` and ``data`` when given."""
    body: dict[str, Any] = {"message": message}
    if progress is not None:
        body["progress"] = progress
    if data is not None:
        body["data"] = data
    return reply_frame(re, "EVENT", body)


def consent_request(service: str, proposal: dict, principal: str | None) -> dict:
    return {
        "proposal": proposal["id"], "hash": proposal["hash"], "service": service,
        "capability": proposal["capability"], "principal": principal,
        "summary": proposal["summary"], "expires": proposal["expires"],
    }
