"""How frames travel: a byte stream (TCP, TLS or stdio), HTTP, or a service in the same process."""

from __future__ import annotations

import asyncio
import concurrent.futures
import threading
import urllib.request
from collections.abc import Callable
from typing import Any

from .._json import dumps, loads
from .reply import KEEP_EVENTS, Kept, OnEvent, Reply

MAX_REPLY = 16 << 20  # the largest reply line a client reads (ts/src/client/transport.ts)
TOO_BIG = "reply exceeds 16 MiB without a newline"
_END = object()  # the end of an HTTP reply stream (a line of JSON null is a frame, not the end)


def _frame_of(line: bytes) -> Any:
    """A reply line as JSON, or None when it isn't JSON (the line is dropped, as TS drops it)."""
    try:
        return loads(line)
    except (ValueError, RecursionError):
        return None


class _StreamTransport:
    def __init__(self, reader: asyncio.StreamReader, writer: Any, proc: Any = None):
        self.reader, self.writer, self.proc = reader, writer, proc
        self.pending: dict[str, tuple[asyncio.Future, Kept, OnEvent | None]] = {}
        self.closed: BaseException | None = None  # why the reader stopped; later requests fail with it
        self.task = asyncio.create_task(self._read())

    async def _read(self) -> None:
        err: BaseException = ConnectionError("connection closed")
        try:
            while True:
                try:
                    line = await self.reader.readline()
                except ValueError:  # a line over the reader's limit
                    err = ConnectionError(TOO_BIG)
                    break
                if not line:
                    break
                if not line.strip():
                    continue
                frame = _frame_of(line)
                re = frame.get("re") if isinstance(frame, dict) else None
                entry = self.pending.get(re) if isinstance(re, str) else None  # anything else is dropped
                if entry is None:
                    continue
                fut, kept, on_event = entry
                if frame.get("kind") == "EVENT":
                    ev = Reply(frame)
                    kept.add(ev)
                    if on_event:
                        r = on_event(ev)
                        if asyncio.iscoroutine(r):
                            await r
                else:
                    self.pending.pop(re, None)
                    if not fut.done():
                        fut.set_result(kept.reply(frame))
        except Exception as e:  # e.g. an on_event callback that raised
            err = e
        # However the reader stops, the connection is done: close it, and fail what's pending and
        # anything sent later, rather than leave requests waiting for replies no one will read.
        self.closed = err
        self.writer.close()
        for fut, _, _ in self.pending.values():
            if not fut.done():
                fut.set_exception(err)
        self.pending.clear()

    async def request(self, frame: dict, on_event: OnEvent | None) -> Reply:
        if self.closed is not None:
            raise self.closed
        fut = asyncio.get_running_loop().create_future()
        self.pending[frame["id"]] = (fut, Kept(), on_event)
        self.writer.write((dumps(frame) + "\n").encode("utf-8"))
        await self.writer.drain()
        return await fut

    async def close(self) -> None:
        self.writer.close()
        self.task.cancel()
        if self.proc is not None:
            try:
                await asyncio.wait_for(self.proc.wait(), 2)
            except asyncio.TimeoutError:
                self.proc.kill()


class _HttpTransport:
    def __init__(self, url: str):
        self.url = url

    def _post(self, frame: dict, hand: Callable[[dict], None]) -> None:
        """POST ``frame`` and hand each reply line to ``hand`` as it arrives, up to the final reply."""
        req = urllib.request.Request(
            self.url, data=dumps(frame).encode("utf-8"), method="POST", headers={"Content-Type": "application/json"}
        )
        with urllib.request.urlopen(req, timeout=60) as resp:
            while line := resp.readline(MAX_REPLY + 1):
                if len(line) > MAX_REPLY and not line.endswith(b"\n"):
                    raise ConnectionError(TOO_BIG)
                got = loads(line) if line.strip() else None
                if isinstance(got, dict):  # anything else (a blank line, a JSON null) isn't a frame
                    hand(got)
                    if got.get("kind") != "EVENT":
                        return  # the final reply: stop reading, as TS does

    async def request(self, frame: dict, on_event: OnEvent | None) -> Reply:
        """EVENTs reach ``on_event`` as they arrive, and nothing piles up: the reading thread waits
        for this loop to take each line (a queue of ``KEEP_EVENTS``), so a slow ``on_event`` holds the
        server back as TS's ``readFinal`` does, and it stops at the next line once this returns."""
        loop = asyncio.get_running_loop()
        lines: asyncio.Queue = asyncio.Queue(maxsize=KEEP_EVENTS)
        stop = threading.Event()

        def hand(f: Any) -> None:
            while not stop.is_set():
                try:
                    asyncio.run_coroutine_threadsafe(lines.put(f), loop).result(timeout=0.5)
                    return
                except concurrent.futures.TimeoutError:
                    continue  # the loop is busy (a slow on_event): wait, unless the caller has gone
            raise ConnectionAbortedError("the request was abandoned")

        def post() -> None:
            try:
                self._post(frame, hand)
            finally:
                if not stop.is_set():
                    asyncio.run_coroutine_threadsafe(lines.put(_END), loop)

        reading = asyncio.ensure_future(asyncio.to_thread(post))
        reading.add_done_callback(lambda t: t.cancelled() or t.exception())  # never "exception never retrieved"
        kept = Kept()
        try:
            while (got := await lines.get()) is not _END:
                if got.get("kind") == "EVENT":
                    ev = Reply(got)
                    kept.add(ev)
                    if on_event:
                        r = on_event(ev)
                        if asyncio.iscoroutine(r):
                            await r
                else:
                    await reading  # raises what the reading thread raised, if anything
                    return kept.reply(got)
            await reading
            raise ConnectionError("HTTP bridge closed without a final reply")
        finally:
            stop.set()  # however this ends (returned, raised, cancelled), the thread stops reading

    async def close(self) -> None:
        pass


class _LocalTransport:
    """Call a Service in-process (tests, embedding). Frames round-trip through JSON."""

    def __init__(self, service: Any):
        self.service = service

    async def request(self, frame: dict, on_event: OnEvent | None) -> Reply:
        kept = Kept()

        def emit(f: dict) -> None:
            ev = Reply(loads(dumps(f)))
            kept.add(ev)
            if on_event:
                on_event(ev)

        final = await self.service.handle(loads(dumps(frame)), emit)
        return kept.reply(loads(dumps(final)))

    async def close(self) -> None:
        pass


def local(service: Any) -> _LocalTransport:
    return _LocalTransport(service)
