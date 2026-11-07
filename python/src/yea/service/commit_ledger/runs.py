"""A run the commit ledger shares: a commit's ``apply``, an undo's ``revert`` or an auto INTENT's
answer, each a task of its own that every caller of the same request waits on.

Python can cancel a caller (a transport may cancel a request's task when its client disconnects),
which TS can't, so a run is shielded: a cancelled caller stops waiting, but the run goes on, still
runs once, and settles or releases what it holds as it finishes, so a retry is a replay.

A run itself is cancelled only when its event loop is torn down with it pending (or its plan raises
``CancelledError``). Once it has started, its plan may have acted, so its outcome is unknown: the run
catches its own cancellation and ends **in doubt**. What it held counts as spent, it is kept so it never runs again, and every retry
gets ``in_doubt``'s error (SPEC §4.4). A run pending on a loop closed without that teardown can never
finish, so it is in doubt too. Only a run cancelled before its first step is known not to have acted,
so the ledger forgets it as it would a failed run. No caller ever receives a run's cancellation as
its own.

A run belongs to the event loop it started on, and the usage ledger isn't thread-safe: serve one
Service from one event loop, and let its requests finish before closing the loop."""

from __future__ import annotations

import asyncio
from collections.abc import Callable

from ...errors import YeaError

# A run's outcome is a RECEIPT or an ERROR reply (or, for an auto INTENT, any final reply).
Run = asyncio.Task

ONE_LOOP = (
    "this request is in flight on another event loop; serve a Service from one event loop, since its "
    "commit ledger is not thread-safe"
)
CANCELLED = "this request's run was cancelled before it started; send the request again"


def in_doubt(what: str) -> YeaError:
    """The error for a ``what`` (commit, undo, auto INTENT) whose run was cut off after it started."""
    return YeaError("internal", f"the outcome of this {what} is unknown: check the service before trying again")


def stranded(run: Run) -> bool:
    """Whether ``run`` is pending on a closed event loop, so it can never finish."""
    return not run.done() and run.get_loop().is_closed()


def forget_if_cancelled(run: Run, forget: Callable[[], None]) -> None:
    """Call ``forget`` when ``run`` ends cancelled, which only a run cancelled before its first step
    does: ``forget`` does the work its own failure handling would have, so a retry starts it afresh."""
    run.add_done_callback(lambda done: forget() if done.cancelled() else None)


def forget(runs: dict[str, Run], key: str, run: Run) -> None:
    """Forget ``run`` if it is still the one kept for ``key``."""
    if runs.get(key) is run:
        del runs[key]


async def outcome(run: Run, what: str) -> dict:
    """The outcome of ``run``, which goes on if this caller is cancelled. A run done on another event
    loop is read as is; one in flight there can't be waited on from here, so it raises ``internal``,
    in doubt if that loop is closed. So does a run that was cancelled, until the ledger forgets it."""
    if not run.done() and run.get_loop() is not asyncio.get_running_loop():
        raise in_doubt(what) if stranded(run) else YeaError("internal", ONE_LOOP)
    try:
        return run.result() if run.done() else await asyncio.shield(run)
    except asyncio.CancelledError:
        if not run.cancelled() or _cancelling():
            raise  # this caller's own cancellation
        raise YeaError("internal", CANCELLED) from None


def _cancelling() -> bool:
    """Whether the current task is being cancelled itself, as when its loop is torn down along with a
    run it waits on. Python 3.10 can't tell, so says no."""
    cancelling = getattr(asyncio.current_task(), "cancelling", None)
    return cancelling is not None and cancelling() > 0
