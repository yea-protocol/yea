"""How frames travel: a byte stream (TCP, TLS or stdio), HTTP, or a service in the same process."""

from __future__ import annotations

import asyncio
import urllib.request
from typing import Any

from .._json import dumps, loads
from .reply import OnEvent, Reply

MAX_REPLY = 16 << 20  # the largest reply line a client reads (ts/src/client/transport.ts)
TOO_BIG = "reply exceeds 16 MiB without a newline"


def _frame_of(line: bytes) -> Any:
    """A reply line as JSON, or None when it isn't JSON (the line is dropped, as TS drops it)."""
    try:
        return loads(line)
    except (ValueError, RecursionError):
        return None


class _StreamTransport:
    def __init__(self, reader: asyncio.StreamReader, writer: Any, proc: Any = None):
        self.reader, self.writer, self.proc = reader, writer, proc
        self.pending: dict[str, tuple[asyncio.Future, list, OnEvent | None]] = {}
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
                fut, events, on_event = entry
                if frame.get("kind") == "EVENT":
                    ev = Reply(frame)
                    events.append(ev)
                    if on_event:
                        r = on_event(ev)
                        if asyncio.iscoroutine(r):
                            await r
                else:
                    self.pending.pop(re, None)
                    if not fut.done():
                        fut.set_result(Reply(frame, events))
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
        self.pending[frame["id"]] = (fut, [], on_event)
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

    def _post(self, frame: dict) -> list[dict]:
        req = urllib.request.Request(
            self.url, data=dumps(frame).encode("utf-8"), method="POST", headers={"Content-Type": "application/json"}
        )
        frames: list[dict] = []
        with urllib.request.urlopen(req, timeout=60) as resp:
            while line := resp.readline(MAX_REPLY + 1):
                if len(line) > MAX_REPLY and not line.endswith(b"\n"):
                    raise ConnectionError(TOO_BIG)
                if line.strip():
                    frames.append(loads(line))
                    if not (isinstance(frames[-1], dict) and frames[-1].get("kind") == "EVENT"):
                        break  # the final reply: stop reading, as TS does
        return frames

    async def request(self, frame: dict, on_event: OnEvent | None) -> Reply:
        frames = await asyncio.to_thread(self._post, frame)
        if not frames:
            raise ConnectionError("empty response from HTTP bridge")
        events = [Reply(f) for f in frames[:-1]]
        for ev in events:
            if on_event:
                r = on_event(ev)
                if asyncio.iscoroutine(r):
                    await r
        return Reply(frames[-1], events)

    async def close(self) -> None:
        pass


class _LocalTransport:
    """Call a Service in-process (tests, embedding). Frames round-trip through JSON."""

    def __init__(self, service: Any):
        self.service = service

    async def request(self, frame: dict, on_event: OnEvent | None) -> Reply:
        events: list[Reply] = []

        def emit(f: dict) -> None:
            ev = Reply(loads(dumps(f)))
            events.append(ev)
            if on_event:
                on_event(ev)

        final = await self.service.handle(loads(dumps(frame)), emit)
        return Reply(loads(dumps(final)), events)

    async def close(self) -> None:
        pass


def local(service: Any) -> _LocalTransport:
    return _LocalTransport(service)
