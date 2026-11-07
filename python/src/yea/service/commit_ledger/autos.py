"""Auto INTENT replays (SPEC §4.3.1): each reply kept by holder key and frame id, so a repeat gets the
original reply and never commits twice. Like ts/src/service/commit-ledger/autos.ts."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import NamedTuple

from ..replies import replay_of
from .runs import Run, outcome

AUTO_MEMORY = 900  # seconds a reply is kept past the later of its arrival and its proof's `ts`
PRUNE_AT = 10_000  # past this many replies kept, a new one prunes those past `exp`


class AutoReplay(NamedTuple):
    """The verified holder key and frame id of an auto INTENT (``key``), and its proof's ``ts``."""

    key: str
    proof_ts: int


@dataclass
class _Kept:
    reply: Run
    exp: int


class AutoReplies:
    def __init__(self) -> None:
        self._replies: dict[str, _Kept] = {}

    async def answer_once(self, replay: AutoReplay, re: str, answer: Callable[[], Awaitable[dict]], now: int) -> dict:
        """The original reply for a repeat, or ``answer()``'s, kept until 900s past the later of
        ``now`` and the proof's ``ts``: that outlives every proof that could carry this frame id."""
        prior = self._replies.get(replay.key)
        if prior is not None and prior.exp > now:
            return replay_of(await outcome(prior.reply), re)
        reply = asyncio.ensure_future(_answered(answer))
        self._replies[replay.key] = _Kept(reply, max(now, replay.proof_ts) + AUTO_MEMORY)
        if len(self._replies) > PRUNE_AT:
            self.forget(now)
        return await outcome(reply)

    def forget(self, now: int) -> None:
        """Forget replies past ``exp``."""
        self._replies = {k: v for k, v in self._replies.items() if v.exp > now}


async def _answered(answer: Callable[[], Awaitable[dict]]) -> dict:
    """``answer()``'s reply. Its own cancellation is a failure, which every repeat gets too (runs.py)."""
    try:
        return await answer()
    except asyncio.CancelledError as e:
        raise RuntimeError("the auto INTENT was cancelled while it ran") from e
