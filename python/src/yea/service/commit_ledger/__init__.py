"""The commit ledger (GLOSSARY.md): each proposal's life, proposed, committed, receipted, undone,
expired or in doubt, and the usage ledger its ``total`` limits count against. A COMMIT is a replay
first (§4.4); otherwise the ledger evaluates the grant with its limits and reserves in the same
synchronous step (ADR-0002). It applies a plan at most once and reverts it at most once. Like
ts/src/service/commit-ledger.ts.

Every run (an apply, a revert, an auto INTENT's answer) is shielded from its caller's cancellation,
which TS has no need for: see runs.py. A commit whose run was cut off after it started (its loop torn
down or closed with it pending) is in doubt: it may have taken effect, so what it held counts as
spent, it never applies again, and every retry gets an error saying its outcome is unknown (SPEC
§4.4). For 900s after, an auto INTENT for the same principal and capability only proposes, since the
agent may be sending the same action again. It does so too after an auto INTENT whose reply was
lost with its loop. One Service serves one event loop, since the usage ledger isn't thread-safe; waiting
on a run in flight on another loop raises ``internal``.

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
from .autos import AUTO_MEMORY, AutoReplay, AutoReplies
from .records import (
    Admit,
    Admitted,
    Answer,
    Commit,
    Doubt,
    InFlight,
    Records,
    StoredProposal,
    StoredReceipt,
    TotalLimit,
    Undo,
    Used,
    receipt_for,
)
from .runs import Run, in_doubt, outcome, stranded
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
        # Until when an auto INTENT for a principal and capability only proposes: see _doubt.
        self._paused: dict[Doubt, int] = {}

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
        can never be used, so it doesn't count; nor does a grant while a commit for its principal
        and capability is in doubt."""
        proposal = stored.proposal
        undo = proposal["undo"]
        if not undo or undo["window"] <= 0:
            return None
        admitted = admit(proposal, self._usage)
        if isinstance(admitted, YeaError):
            return None
        doubt = Doubt(admitted.iss, proposal["capability"])
        if self._is_paused(doubt):
            return None
        r = self._usage.reserve_all(proposal, admitted.totals)
        if isinstance(r, TotalLimit):
            # Over a `total` here means a commit in flight took the room: a proposal, as with no grant.
            return None
        try:
            return await self._start(stored, admitted.iss, r, answer)
        except asyncio.CancelledError:
            self._pause(doubt)  # the auto INTENT's reply is lost with its caller, whatever the run did
            raise

    async def undo(self, req: Undo, emit: Emit) -> dict:
        """Revert a receipt's plan once, inside its undo window (§4.5); a repeat gets the original outcome."""
        return await undo_once(self._records.undos, req, emit, self._now)

    async def answer_once(self, replay: AutoReplay, re: str, answer: Callable[[], Awaitable[dict]]) -> dict:
        """Answer an auto INTENT once per replay key (§4.3.1): a repeat gets the original reply."""
        return await self._autos.answer_once(replay, re, answer, self._now())

    def sweep(self) -> None:
        """Forget expired proposals, receipts a day past their undo window, stale auto replies and
        pauses, once each commit stranded on a closed loop is in doubt."""
        now = self._now()
        self._doubt_stranded()
        sweep(self._records, now)
        self._autos.forget(now)
        self._paused = {d: until for d, until in self._paused.items() if until > now}

    async def _replay(self, prior: Run, req: Commit) -> dict:
        """A replay of a commit (§4.4): only for the principal whose grant committed it."""
        out = await outcome(prior, "commit")
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
        self._records.in_flight[pid] = InFlight(run, Doubt(principal, stored.proposal["capability"]), held)
        run.add_done_callback(lambda done: self._ended(pid, done))
        return await outcome(run, "commit")

    def _ended(self, pid: str, run: Run) -> None:
        """``run`` is no longer in flight. Done cancelled, it never started (``_apply`` catches its own
        cancellation), so it is forgotten as a failed run is, and frees what it held."""
        f = self._records.in_flight.get(pid)
        if f is None or f.run is not run:
            return
        del self._records.in_flight[pid]
        if run.cancelled():
            self._free(pid, f.held)

    async def _apply(self, stored: StoredProposal, principal: str, held: list[Reservation], answer: Answer) -> dict:
        """Perform the plan's effects and keep the receipt. A failure frees the proposal and its
        reservations; cut off, the commit is in doubt."""
        proposal, plan = stored.proposal, stored.plan

        def progress(message: str, pct: float | None, data: Any) -> None:
            answer.emit(event_frame(answer.re, message, pct, data))

        try:
            result = await _call(plan.apply, CommitCtx(principal, progress))
            receipt = receipt_for(proposal, result, self._now())
        except asyncio.CancelledError:
            self._doubt(proposal["id"], Doubt(principal, proposal["capability"]), held)
            return error_reply(answer.re, in_doubt("commit"))
        except Exception as e:
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

    def _doubt(self, pid: str, doubt: Doubt, held: list[Reservation]) -> None:
        """Leave a commit in doubt (runs.py): what it held counts as spent, and its run stays, so a
        retry gets its outcome and it never applies again. An auto INTENT like it only proposes, for
        a while."""
        self._records.in_doubt.add(pid)
        for h in held:
            self._usage.settle(h)
        self._pause(doubt)

    def _doubt_stranded(self) -> None:
        """Leave in doubt each commit whose run is stranded on a closed loop: it can never finish."""
        for pid, f in list(self._records.in_flight.items()):
            if stranded(f.run):
                del self._records.in_flight[pid]
                self._doubt(pid, f.doubt, f.held)

    def _pause(self, doubt: Doubt) -> None:
        """Auto INTENTs like ``doubt`` only propose for the next 900s, as long as a reply is kept."""
        self._paused[doubt] = self._now() + AUTO_MEMORY

    def _is_paused(self, doubt: Doubt) -> bool:
        """Whether auto INTENTs like ``doubt`` only propose, once commits stranded since are in doubt."""
        self._doubt_stranded()
        return self._paused.get(doubt, 0) > self._now()
