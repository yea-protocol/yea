"""A run the commit ledger shares: a commit's ``apply``, an undo's ``revert`` or an auto INTENT's
answer, each a task of its own that every caller of the same request waits on.

Python can cancel a caller (a transport may cancel a request's task when its client disconnects),
which TS can't, so a run is shielded: a cancelled caller stops waiting, but the run goes on, still
runs once, and settles or releases what it holds as it finishes, so a retry is a replay. A run
also turns a ``CancelledError`` raised inside it into a failure, so no other caller ever receives
it as its own.

A run belongs to the event loop it started on, and the usage ledger isn't thread-safe: serve one
Service from one event loop."""

from __future__ import annotations

import asyncio

from ...errors import YeaError

# A run's outcome is a RECEIPT or an ERROR reply (or, for an auto INTENT, any final reply).
Run = asyncio.Task

ONE_LOOP = (
    "this request is in flight on another event loop; serve a Service from one event loop, since its "
    "commit ledger is not thread-safe"
)


async def outcome(run: Run) -> dict:
    """The outcome of ``run``, which goes on if this caller is cancelled. A run done on another event
    loop is read as is; one in flight there can't be waited on from here, so it raises ``internal``."""
    if run.done():
        return run.result()
    if run.get_loop() is not asyncio.get_running_loop():
        raise YeaError("internal", ONE_LOOP)
    return await asyncio.shield(run)
