"""Bounding a service's memory: expired proposals, old receipts and stale auto-INTENT replays are
forgotten now and then (mirrors ts/src/service/sweep.ts)."""

from __future__ import annotations

from typing import TYPE_CHECKING

from .util import DAY

if TYPE_CHECKING:
    from . import Service

SWEEP_EVERY = 100  # INTENTs between sweeps
SWEEP_AT = 5000  # proposals held that trigger a sweep on every INTENT
PROPOSAL_GRACE = 3600  # seconds an uncommitted proposal is kept past its expiry


def sweep(svc: Service, now: int) -> None:
    """Forget uncommitted proposals an hour past their expiry, receipts (with their proposal and
    commit) a day after their undo window or their time, and auto-INTENT replays past theirs."""
    svc._sweeps += 1
    if svc._sweeps % SWEEP_EVERY and len(svc._proposals) < SWEEP_AT:
        return
    for pid, s in list(svc._proposals.items()):
        if s.proposal["expires"] < now - PROPOSAL_GRACE and pid not in svc._commits:
            del svc._proposals[pid]
    for rid, r in list(svc._receipts.items()):
        undo = r.receipt.get("undo")
        if (undo["until"] if undo else r.receipt["at"]) + DAY < now:
            del svc._receipts[rid]
            svc._commits.pop(r.receipt["proposal"], None)
            svc._proposals.pop(r.receipt["proposal"], None)
    for key, (_task, exp) in list(svc._auto_seen.items()):
        if exp <= now:
            del svc._auto_seen[key]
