"""The pending files a job call writes and removes (SPEC-approval §6, Short ids): each consent code
goes in the store's ``pending/`` under a short id, so the person types ``yea approve <id>``; a plan
that runs takes its files with it. A store that isn't a FileStore gets no files, and a file that
can't be written costs the ids, never the codes. As mcp-ts's call/pending.ts."""

from __future__ import annotations

from yea.store import pending_codes_of

from ..util import warn_once
from .model import Call


def with_ids(call: Call, codes: list[dict]) -> list[dict]:
    """The codes with their ids, or as they are if there is nowhere to write or a write fails."""
    pending = pending_codes_of(call.y.store)
    if pending is None or not codes:
        return codes
    try:
        return [{**c, "id": pending.put(c["code"], call.now)} for c in codes]
    except (OSError, ValueError) as e:
        warn_once(f"can't write a pending file, so no short ids: {e}")
        return codes


def drop_pending(call: Call, plan_hash: str) -> None:
    """A plan that runs needs no approval any more: remove its pending files."""
    pending = pending_codes_of(call.y.store)
    try:
        if pending is not None:
            pending.drop(call.y.service_id, plan_hash)
    except OSError as e:
        warn_once(f"can't remove a pending file: {e}")
