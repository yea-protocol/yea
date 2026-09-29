"""Bounding a service's memory: expired proposals, old receipts and stale auto-INTENT replays are
forgotten now and then (mirrors ts/src/service/sweep.ts)."""

from __future__ import annotations

from .state import ServiceState
from .util import DAY

SWEEP_EVERY = 100  # INTENTs between sweeps
SWEEP_AT = 5000  # proposals held that trigger a sweep on every INTENT
PROPOSAL_GRACE = 3600  # seconds an uncommitted proposal is kept past its expiry


def sweep(state: ServiceState, now: int) -> None:
    """Forget uncommitted proposals an hour past their expiry, receipts (with their proposal and
    commit) a day after their undo window or their time, and auto-INTENT replays past theirs."""
    state.sweeps += 1
    if state.sweeps % SWEEP_EVERY and len(state.proposals) < SWEEP_AT:
        return
    for pid, s in list(state.proposals.items()):
        if s.proposal["expires"] < now - PROPOSAL_GRACE and pid not in state.commits:
            del state.proposals[pid]
    for rid, r in list(state.receipts.items()):
        undo = r.receipt.get("undo")
        if (undo["until"] if undo else r.receipt["at"]) + DAY < now:
            del state.receipts[rid]
            state.commits.pop(r.receipt["proposal"], None)
            state.proposals.pop(r.receipt["proposal"], None)
    for key, (_task, exp) in list(state.auto_seen.items()):
        if exp <= now:
            del state.auto_seen[key]
