"""The commit ledger (GLOSSARY.md): each proposal's life, proposed, committed, receipted, undone or
expired, and the usage ledger its ``total`` limits count against. A COMMIT is a replay first
(§4.4); otherwise the ledger evaluates the grant with its limits and reserves in the same
synchronous step (ADR-0002). It applies a plan at most once and reverts it at most once. Like
ts/src/service/commit-ledger.ts.

Every run (an apply, a revert, an auto INTENT's answer) is shielded from its caller's cancellation,
which TS has no need for: see runs.py. One Service serves one event loop, since the usage ledger
isn't thread-safe; waiting on a run in flight on another loop raises ``internal``.

The entry of the ``commit_ledger`` package: its other modules are private to it."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from typing import Any

from ...errors import YeaError, fix
from ...store import Reservation
from ..plan import CommitCtx
from ..replies import consent_request, error_reply, event_frame, replay_of, reply_frame
from ..util import Emit, _call
from .autos import AutoReplay, AutoReplies
from .records import (
    Admit,
    Admitted,
    Answer,
    Commit,
    Records,
    StoredProposal,
    StoredReceipt,
    TotalLimit,
    Undo,
    Used,
    receipt_for,
)
from .runs import Run, forget_if_cancelled, outcome
from .sweep import sweep
from .undo import undo_once
from .usage import UsageLedger

__all__ = [
    "Admit",
    "Admitted",
    "Answer",
    "AutoReplay",
    "Commit",
    "CommitLedger",
    "StoredProposal",
    "StoredReceipt",
    "TotalLimit",
    "Undo",
    "Used",
]

# A sweep runs on every 100th INTENT, or on each one while this many proposals are kept.
SWEEP_EVERY = 100
SWEEP_AT = 5000


class CommitLedger:
    def __init__(self, id: str, now: Callable[[], int]):
        self._id, self._now = id, now
        self._records = Records()
        self._autos = AutoReplies()
        self._usage = UsageLedger()
        self._intents = 0

    def propose(self, stored: list[StoredProposal]) -> None:
        """Keep an INTENT's proposals; every so often, sweep first what has expired."""
        for s in stored:
            self._records.proposals[s.proposal["id"]] = s
        self._intents += 1
        if self._intents % SWEEP_EVERY == 0 or len(self._records.proposals) >= SWEEP_AT:
            self.sweep()

    def proposal(self, id: str) -> StoredProposal | None:
        return self._records.proposals.get(id)

    def receipt(self, id: str) -> StoredReceipt | None:
        """A receipt the ledger issued for a commit (never an undo receipt)."""
        return self._records.receipts.get(id)

    async def commit(self, req: Commit, emit: Emit) -> dict:
        """Commit a proposal once (§4.4). A repeat gets the original outcome, for the same principal
        only, with no limit re-evaluated. Otherwise an expired proposal is refused before its limits,
        so it never asks for consent. Then the grant's limits are evaluated, and the reservation
        follows with no await in between, so concurrent commits can't overshoot a ``total``. Raises
        the error to reply with when the proposal expired or no grant admits it."""
        proposal = req.stored.proposal
        prior = self._records.runs.get(proposal["id"])
        if prior is not None:
            return await self._replay(prior, req)
        if self._now() >= proposal["expires"]:
            raise YeaError("expired", "this proposal has expired", fix=[fix("send INTENT again to get a fresh proposal")])
        admitted = req.admit(proposal, self._usage)
        if isinstance(admitted, YeaError):
            raise admitted
        r = self._usage.reserve_all(proposal, admitted.totals)
        if isinstance(r, TotalLimit):
            # Grant evaluation just read this same usage, so this fails closed only if the two disagree.
            raise YeaError(
                "consent_required",
                f"{r.of} would pass a total limit (other commits are in flight); your principal must approve this exact proposal",
                consent=consent_request(self._id, proposal, admitted.iss),
            )
        return await self._start(req.stored, admitted.iss, r, Answer(req.id, emit))

    async def auto_commit(self, stored: StoredProposal, admit: Admit, answer: Answer) -> dict | None:
        """Commit an auto INTENT's fresh proposal now if it is undoable and its grant admits it
        outright (§4.3.1): the same step as a COMMIT. None leaves it a proposal. An undo window of 0
        can never be used, so it doesn't count."""
        undo = stored.proposal["undo"]
        if not undo or undo["window"] <= 0:
            return None
        admitted = admit(stored.proposal, self._usage)
        if isinstance(admitted, YeaError):
            return None
        r = self._usage.reserve_all(stored.proposal, admitted.totals)
        # Over a `total` here means a commit in flight took the room: a proposal, as with no grant.
        return None if isinstance(r, TotalLimit) else await self._start(stored, admitted.iss, r, answer)

    async def undo(self, req: Undo, emit: Emit) -> dict:
        """Revert a receipt's plan once, inside its undo window (§4.5); a repeat gets the original outcome."""
        return await undo_once(self._records.undos, req, emit, self._now)

    async def answer_once(self, replay: AutoReplay, re: str, answer: Callable[[], Awaitable[dict]]) -> dict:
        """Answer an auto INTENT once per replay key (§4.3.1): a repeat gets the original reply."""
        return await self._autos.answer_once(replay, re, answer, self._now())

    def sweep(self) -> None:
        """Forget expired proposals, receipts a day past their undo window, and stale auto replies."""
        now = self._now()
        sweep(self._records, now)
        self._autos.forget(now)

    async def _replay(self, prior: Run, req: Commit) -> dict:
        """A replay of a commit (§4.4): only for the principal whose grant committed it."""
        out = await outcome(prior)
        if out["kind"] == "RECEIPT":
            stored = self._records.receipts.get(out["receipt"]["id"])
            if stored is None or stored.principal != req.principal:
                raise YeaError("forbidden", "this proposal was committed by a different principal")
        return replay_of(out, req.id)

    async def _start(self, stored: StoredProposal, principal: str, held: list[Reservation], answer: Answer) -> dict:
        """Start the run of a proposal whose reservations are held. It is stored before apply starts:
        a synchronous raise from ``plan.apply`` then finds its entry to delete, so a retry runs apply
        again (#187)."""
        pid = stored.proposal["id"]
        run = asyncio.ensure_future(self._apply(stored, principal, held, answer))
        self._records.runs[pid] = run
        forget_if_cancelled(run, lambda: self._free(pid, held))
        return await outcome(run)

    async def _apply(self, stored: StoredProposal, principal: str, held: list[Reservation], answer: Answer) -> dict:
        """Perform the plan's effects and keep the receipt; a failure frees the proposal and its reservations."""
        proposal, plan = stored.proposal, stored.plan

        def progress(message: str, pct: float | None, data: Any) -> None:
            answer.emit(event_frame(answer.re, message, pct, data))

        try:
            result = await _call(plan.apply, CommitCtx(principal, progress))
            receipt = receipt_for(proposal, result, self._now())
        except (Exception, asyncio.CancelledError) as e:  # its own cancellation too (runs.py)
            self._free(proposal["id"], held)
            return error_reply(answer.re, e)
        self._records.receipts[receipt["id"]] = StoredReceipt(receipt, plan, result, principal)
        for h in held:
            self._usage.settle(h)
        return reply_frame(answer.re, "RECEIPT", {"receipt": receipt})

    def _free(self, pid: str, held: list[Reservation]) -> None:
        """Forget the run of a commit that failed or never started, so it may be retried, and release
        what it held."""
        self._records.runs.pop(pid, None)
        for h in held:
            self._usage.release(h)
