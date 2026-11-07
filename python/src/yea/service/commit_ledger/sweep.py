"""Bounding the ledger's memory: forget expired proposals and old receipts. Like
ts/src/service/commit-ledger/sweep.ts."""

from __future__ import annotations

from ..util import DAY
from .records import Records

PROPOSAL_GRACE = 3600  # seconds an uncommitted proposal is kept past its expiry


def sweep(r: Records, now: int) -> None:
    """Forget proposals an hour past expiry that no commit is running or ran, and receipts (with their
    proposal, run and undo) a day after their undo window, or their time when they have none."""
    for pid, s in list(r.proposals.items()):
        if s.proposal["expires"] < now - PROPOSAL_GRACE and pid not in r.runs:
            del r.proposals[pid]
    for rid, s in list(r.receipts.items()):
        undo = s.receipt["undo"]
        if (undo["until"] if undo else s.receipt["at"]) + DAY < now:
            del r.receipts[rid]
            r.undos.pop(rid, None)
            r.runs.pop(s.receipt["proposal"], None)
            r.proposals.pop(s.receipt["proposal"], None)
