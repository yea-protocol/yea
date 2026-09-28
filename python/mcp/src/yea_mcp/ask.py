"""Asking the person, per protocol era (SPEC-mcp-py, "Asking, per era"), and whether the client
can take a form at all.

SDK seams: ``session.client_capabilities`` (recorded from ``initialize`` on 2025, per request on
2026); a raw ``InputRequiredResult`` works only on 2026 clients, so 2025 clients are asked inside
the call with ``session.elicit_form``, which raises ``NoBackChannelError`` when the connection
can't send requests to the client."""

from __future__ import annotations

import json
from typing import Any

import mcp_types as t
from mcp.shared.exceptions import NoBackChannelError
from mcp_types.version import MODERN_PROTOCOL_VERSIONS
from pydantic import ValidationError


def is_modern(protocol_version: str | None) -> bool:
    return protocol_version in MODERN_PROTOCOL_VERSIONS


def can_elicit_form(caps: Any) -> bool:
    """``elicitation.form``, or a bare ``elicitation: {}`` (the pre-mode meaning), means yes."""
    e = getattr(caps, "elicitation", None) if caps is not None else None
    if e is None:
        return False
    return getattr(e, "form", None) is not None or getattr(e, "url", None) is None


def can_ask(session: Any) -> bool:
    return can_elicit_form(getattr(session, "client_capabilities", None))


def input_required(form: dict, state: dict) -> t.InputRequiredResult:
    """The 2026 ask: the form, and our state, which the SDK seals on the way out."""
    request = t.ElicitRequest(params=t.ElicitRequestFormParams(message=form["message"],
                                                              requested_schema=form["requested_schema"]))
    return t.InputRequiredResult(input_requests={"yea": request}, request_state=json.dumps({"yea": state}))


async def ask_in_call(session: Any, request_id: Any, form: dict) -> dict | None:
    """The 2025 ask, inside the call. The answer as the core judges it, or None when the client
    can't be reached (the caller fails closed with consent codes)."""
    try:
        r = await session.elicit_form(message=form["message"], requested_schema=form["requested_schema"],
                                      related_request_id=request_id)
    except NoBackChannelError:
        return None
    return {"action": r.action, **({"content": r.content} if r.content is not None else {})}


def answer_of(responses: Any) -> dict:
    """The ``yea`` entry of the input responses, as the core judges it. A missing or malformed one
    is not an approval."""
    raw = responses.get("yea") if isinstance(responses, dict) else None
    if isinstance(raw, t.ElicitResult):
        raw = raw.model_dump(exclude_none=True)
    try:
        r = t.ElicitResult.model_validate(raw)
    except ValidationError:
        return {"action": "decline"}
    return {"action": r.action, **({"content": r.content} if r.content is not None else {})}


def parse_state(raw: Any) -> tuple[str, Any]:
    """Step 5: ``("fresh", None)``, ``("ours", state)``, or ``("foreign", why)``."""
    if raw is None:
        return "fresh", None
    try:
        doc = json.loads(raw) if isinstance(raw, str) else None
    except ValueError:
        doc = None
    if not isinstance(doc, dict) or "yea" not in doc:
        return "foreign", "requestState belongs to something else, not this job's approval"
    return "ours", doc["yea"]
