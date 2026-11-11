"""The commit ledger (GLOSSARY.md): each proposal's life, proposed, committed, receipted, undone,
expired or in doubt, and the usage ledger its ``total`` limits count against. A COMMIT is a replay
first (§4.4); otherwise the ledger evaluates the grant with its limits and reserves in the same
synchronous step (ADR-0002). A proposal takes effect at most once, and so does its undo. Like
ts/src/service/commit-ledger.ts.

Every run (an apply, a revert, an auto INTENT's answer) is shielded from its caller's cancellation,
which TS has no need for: see runs.py. A plan's ``apply`` that raises says it took no effect (SPEC
§4.4), so the proposal is freed for a retry, as in TS. Anything else that stops a commit once
``apply`` started (its loop torn down, closed or dropped, an exit, a failure after ``apply``
returned) leaves it in doubt: it may have taken effect, so what it held counts as spent, it never
applies again, and every retry gets an error saying its outcome is unknown. For 900s after, an auto
INTENT for the same principal and capability only proposes (§4.3.1), since the agent may be sending
the same action again. An auto INTENT cut off while its commit ran keeps that commit's outcome when
it finished, a receipt the agent can undo, and is in doubt when it hadn't. One Service serves one
event loop, since the usage ledger isn't thread-safe; waiting on a run in flight on another running
loop raises ``internal``.

The entry of the ``commit_ledger`` package: its other modules are private to it."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from typing import Any

from ...errors import YeaError, fix
from ...grants import TotalLimit
from ...store import Reservation
from ...undo_window import is_undo_window
from ..plan import CommitCtx
from ..replies import consent_request, error_reply, event_frame, log, replay_of, reply_frame
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
                f"{r.key.of} would pass a total limit (other commits are in flight); your principal must approve this exact proposal",
                consent=consent_request(self._id, proposal, admitted.iss),
            )
        return await outcome(self._start(req.stored, admitted.iss, r, Answer(req.id, emit)), "commit")

    async def auto_commit(self, stored: StoredProposal, admit: Admit, answer: Answer) -> dict | None:
        """Commit an auto INTENT's fresh proposal now if it is undoable and its grant admits it
        outright (§4.3.1): the same step as a COMMIT. None leaves it a proposal. Undoable means a
        window that is a positive integer (``is_undo_window``): any other can never be used, so it
        doesn't count. Nor does a grant while a commit for its principal and capability is in doubt."""
        proposal = stored.proposal
        undo = proposal["undo"]
        if not (isinstance(undo, dict) and is_undo_window(undo.get("window"))):
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
        run = self._start(stored, admitted.iss, r, answer)
        try:
            return await outcome(run, "commit")
        except asyncio.CancelledError:
            if run.cancelled():
                raise  # cut off before its run started: nothing happened, so the answer is forgotten
            return self._cut_off(run, doubt, answer.re)

    async def undo(self, req: Undo, emit: Emit) -> dict:
        """Revert a receipt's plan once, inside its undo window (§4.5); a repeat gets the original outcome."""
        return await undo_once(self._records.undos, req, emit, self._now)

    async def answer_once(self, replay: AutoReplay, re: str, answer: Callable[[], Awaitable[dict]]) -> dict:
        """Answer an auto INTENT once per replay key (§4.3.1): a repeat gets the original reply."""
        return await self._autos.answer_once(replay, re, answer, self._now())

    def sweep(self) -> None:
        """Forget expired proposals, receipts a day past their undo window, stale auto replies and
        pauses, once each commit stranded on a loop that no longer runs is in doubt."""
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

    def _start(self, stored: StoredProposal, principal: str, held: list[Reservation], answer: Answer) -> Run:
        """Start, and return, the run of a proposal whose reservations are held. It is stored before
        apply starts: a synchronous raise from ``plan.apply`` then finds its entry to delete, so a
        retry runs apply again (#187)."""
        pid = stored.proposal["id"]
        run = asyncio.ensure_future(self._apply(stored, principal, held, answer))
        self._records.runs[pid] = run
        self._records.in_flight[pid] = InFlight(run, Doubt(principal, stored.proposal["capability"]), held)
        run.add_done_callback(lambda done: self._ended(pid, done))
        return run

    def _cut_off(self, run: Run, doubt: Doubt, re: str) -> dict:
        """The reply of an auto INTENT cut off while its commit ran: what a repeat of it gets, since
        ``auto_commit`` runs in the answer the ledger keeps (autos.py), which only its loop's teardown
        cancels. A run that finished gives its own outcome, so a receipt stays reachable and can be
        undone. One still running is in doubt, and auto INTENTs like it pause."""
        if run.done() and run.exception() is None:
            return run.result()
        self._pause(doubt)
        return error_reply(re, in_doubt("commit"))

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
        """Perform the plan's effects and keep the receipt. ``apply`` raising says it had no effect
        (SPEC §4.4), which frees the proposal and its reservations. Anything else that stops the run
        once ``apply`` started leaves the commit in doubt (runs.py): a cancellation, an exit (which
        still reaches the host), or a failure after ``apply`` returned."""
        proposal = stored.proposal
        pid, doubt = proposal["id"], Doubt(principal, proposal["capability"])

        def progress(message: str, pct: float | None, data: Any) -> None:
            answer.emit(event_frame(answer.re, message, pct, data))

        try:
            result = await _call(stored.plan.apply, CommitCtx(principal, progress))
        except Exception as e:
            self._free(pid, held)
            return error_reply(answer.re, e)
        except asyncio.CancelledError:
            self._doubt(pid, doubt, held)
            return error_reply(answer.re, in_doubt("commit"))
        except BaseException:
            self._doubt(pid, doubt, held)
            raise
        try:
            return self._receipted(stored, principal, held, result, answer.re)
        except Exception:
            log.exception("a commit failed after its plan's apply returned, so it is in doubt")
            self._doubt(pid, doubt, held)
            return error_reply(answer.re, in_doubt("commit"))

    def _receipted(self, stored: StoredProposal, principal: str, held: list[Reservation], result: Any, re: str) -> dict:
        """Keep the receipt for a plan ``apply`` performed, and settle what it held. A run put in doubt
        while its loop stood still, then finished, is in doubt no longer."""
        receipt = receipt_for(stored.proposal, result, self._now())
        self._records.receipts[receipt["id"]] = StoredReceipt(receipt, stored.plan, result, principal)
        self._records.in_doubt.discard(stored.proposal["id"])
        for h in held:
            self._usage.settle(h)
        return reply_frame(re, "RECEIPT", {"receipt": receipt})

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
        """Leave in doubt each commit whose run is stranded on a loop that no longer runs: it can
        never finish there."""
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
