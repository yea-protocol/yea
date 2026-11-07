"""A run the commit ledger shares: a commit's ``apply``, an undo's ``revert`` or an auto INTENT's
answer, each a task of its own that every caller of the same request waits on.

Python can cancel a caller (a transport may cancel a request's task when its client disconnects),
which TS can't, so a run is shielded: a cancelled caller stops waiting, but the run goes on, still
runs once, and settles or releases what it holds as it finishes, so a retry is a replay. A run
also turns a ``CancelledError`` raised inside it into a failure. One cancelled before its first step
(a loop closed in between) never reaches that handling, so the ledger forgets it as it would a
failed run. Either way no caller ever receives a run's cancellation as its own.

A run belongs to the event loop it started on, and the usage ledger isn't thread-safe: serve one
Service from one event loop."""

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


def forget_if_cancelled(run: Run, forget: Callable[[], None]) -> None:
    """Call ``forget`` when ``run`` ends cancelled, which only a run cancelled before its first step
    does: ``forget`` does the work its own failure handling would have, so a retry starts it afresh."""
    run.add_done_callback(lambda done: forget() if done.cancelled() else None)


async def outcome(run: Run) -> dict:
    """The outcome of ``run``, which goes on if this caller is cancelled. A run done on another event
    loop is read as is; one in flight there can't be waited on from here, so it raises ``internal``.
    So does a run that was cancelled, until the ledger forgets it."""
    if not run.done() and run.get_loop() is not asyncio.get_running_loop():
        raise YeaError("internal", ONE_LOOP)
    try:
        return run.result() if run.done() else await asyncio.shield(run)
    except asyncio.CancelledError:
        if not run.cancelled():
            raise  # this caller's own cancellation
        raise YeaError("internal", CANCELLED) from None
