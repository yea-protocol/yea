"""Server transports: NDJSON over TCP or stdio, and the HTTP bridge (SPEC §2.3–2.4)."""

from __future__ import annotations

import asyncio
import logging
import re
import ssl as ssl_module
import sys
from typing import Any
from urllib.parse import parse_qs

from ._json import dumps, loads
from .service import Service, _positive_int

log = logging.getLogger("yea")

MAX_FRAME = 1 << 20  # 1 MiB (SPEC §2.1)
# ?budget= takes plain decimal notation, as in TS (http.ts): no hex, inf, underscores, spaces or non-ASCII digits.
_DECIMAL = re.compile(r"[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?", re.ASCII)
_MAX_BUDGET_TEXT = 32  # longer than any budget worth reading; checked before the pattern runs
MAX_INFLIGHT = 64  # concurrent requests per stream connection
DEFAULT_PORT = 7447
TLS_PORT = 7448


def _parse(line: bytes) -> Any:
    """Parse a request line; anything unparseable becomes None, which ``handle`` rejects as bad_frame."""
    try:
        return loads(line.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return None


def _error(id: str, re: str, code: str, message: str, **extra: Any) -> dict:
    """An ERROR frame the transport sends itself, with TS's ids (``s_err``, ``s_busy``)."""
    return {"yea": 1, "id": id, "re": re, "kind": "ERROR", "code": code, "message": message, **extra}


def _event_line(event: dict) -> str | None:
    """An EVENT as one line, or None (logged and dropped) if it can't be serialized. Raising here
    would fail the handler mid-``apply``, and a retry would run ``apply`` again."""
    try:
        return dumps(event) + "\n"
    except Exception:  # noqa: BLE001
        log.warning("dropped an EVENT that could not be serialized (re=%s)", event.get("re"))
        return None


def _query_budget(text: str) -> int | None:
    """``?budget=`` read by the same rule as a frame's ``budget``: a whole number above 0 in decimal
    notation (``800.0`` and ``1e3`` count); anything else, including non-ASCII digits, gets the default."""
    if len(text) > _MAX_BUDGET_TEXT or not _DECIMAL.fullmatch(text):
        return None
    return _positive_int(float(text))


def _frame_id(frame: Any) -> str:
    return frame["id"] if isinstance(frame, dict) and isinstance(frame.get("id"), str) else "?"


def _final_line(reply: dict, frame: Any) -> str:
    """The final reply as one line. A reply that can't be serialized (NaN, a non-string key) is
    replaced by an ERROR, so every request still gets exactly one final reply (§2.2)."""
    try:
        return dumps(reply) + "\n"
    except Exception:  # noqa: BLE001 — whatever it is, the request still gets its final reply
        return dumps(_error("s_err", _frame_id(frame), "internal", "reply could not be serialized")) + "\n"


async def _lines(reader: asyncio.StreamReader):
    """Yield complete lines, or None for each line over MAX_FRAME. An oversized line is
    discarded as it streams in (never buffered whole) and the stream stays usable (§2.1)."""
    buf = bytearray()
    discarding = False
    while True:
        chunk = await reader.read(65536)
        if not chunk:
            return
        while chunk:
            nl = chunk.find(b"\n")
            part, chunk = (chunk, b"") if nl < 0 else (chunk[:nl], chunk[nl + 1:])
            if not discarding:
                buf += part
                if len(buf) > MAX_FRAME:
                    discarding, buf = True, bytearray()
            if nl >= 0:
                yield None if discarding else bytes(buf)
                discarding, buf = False, bytearray()


async def serve_stream(service: Service, reader: asyncio.StreamReader, writer: Any) -> None:
    """Serve one NDJSON connection. Requests are handled concurrently (at most MAX_INFLIGHT
    at once); replies are correlated by ``re``. ``writer`` needs ``write``, ``drain``,
    ``close`` and ``is_closing``."""
    tasks: set[asyncio.Task] = set()

    def send(frame: dict) -> None:
        # write() is synchronous and buffers whole lines, so frames never interleave.
        line = _event_line(frame)
        if line is not None and not writer.is_closing():
            writer.write(line.encode("utf-8"))

    async def run(frame: Any) -> None:
        line = _final_line(await service.handle(frame, send), frame)
        if not writer.is_closing():
            writer.write(line.encode("utf-8"))
        try:
            await writer.drain()
        except (ConnectionError, RuntimeError):
            pass  # peer went away mid-reply

    try:
        async for line in _lines(reader):
            if line is None:
                send(_error("s_err", "?", "bad_frame", "frame exceeds 1 MiB"))
                continue
            if not line.strip():
                continue
            frame = _parse(line)
            if len(tasks) >= MAX_INFLIGHT:
                send(_error("s_busy", _frame_id(frame), "limit",
                            f"more than {MAX_INFLIGHT} requests in flight on this connection", retry=1))
                continue
            t = asyncio.create_task(run(frame))
            tasks.add(t)
            t.add_done_callback(tasks.discard)
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
    except ConnectionError:
        pass
    finally:
        try:
            writer.close()
        except Exception:
            pass


async def serve_tcp(
    service: Service, host: str = "127.0.0.1", port: int | None = None, *, ssl: ssl_module.SSLContext | None = None
) -> asyncio.base_events.Server:
    """Start a ``yea://`` server (or ``yeas://`` when ``ssl`` is given) and return it, listening."""
    port = (TLS_PORT if ssl else DEFAULT_PORT) if port is None else port
    return await asyncio.start_server(lambda r, w: serve_stream(service, r, w), host, port, limit=MAX_FRAME + 2, ssl=ssl)


async def serve_stdio(service: Service) -> None:
    """Serve NDJSON on this process's stdin/stdout (the ``stdio:`` transport)."""
    loop = asyncio.get_running_loop()
    reader = asyncio.StreamReader(limit=MAX_FRAME + 2)
    await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), sys.stdin)
    transport, protocol = await loop.connect_write_pipe(asyncio.streams.FlowControlMixin, sys.stdout)
    writer = asyncio.StreamWriter(transport, protocol, reader, loop)
    await serve_stream(service, reader, writer)


# ------------------------------------------------------------ HTTP bridge

_REASONS = {200: "OK", 404: "Not Found", 413: "Payload Too Large"}


async def _http_conn(service: Service, path: str, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    async def respond(status: int, ctype: str, body: bytes) -> None:
        head = (
            f"HTTP/1.1 {status} {_REASONS[status]}\r\nContent-Type: {ctype}\r\n"
            f"Content-Length: {len(body)}\r\nConnection: close\r\n\r\n"
        )
        writer.write(head.encode("latin-1") + body)
        await writer.drain()

    try:
        request_line = (await reader.readline()).decode("latin-1").strip()
        headers: dict[str, str] = {}
        while True:
            line = (await reader.readline()).decode("latin-1")
            if line in ("\r\n", "\n", ""):
                break
            k, _, v = line.partition(":")
            headers[k.strip().lower()] = v.strip()
        method, target, *_ = request_line.split(" ") + ["", ""]
        target, _, query = target.partition("?")

        if method == "GET" and target in (path, "/.well-known/yea"):
            brief = service.brief(_query_budget(parse_qs(query).get("budget", [""])[0]))
            await respond(200, "application/json", dumps({**brief, "endpoint": path}).encode("utf-8"))
        elif method == "POST" and target == path:
            length = int(headers.get("content-length", "0") or 0)
            if length > MAX_FRAME:
                await respond(413, "text/plain", b"frame exceeds 1 MiB")
                # Read and drop (never buffer) what the client is still sending, so it sees the
                # 413 instead of a reset. Give up past a bound.
                left = min(length, 8 * MAX_FRAME)
                while left > 0 and (chunk := await reader.read(min(left, 65536))):
                    left -= len(chunk)
                return
            # Chunked so EVENTs reach the client as they happen.
            writer.write(
                b"HTTP/1.1 200 OK\r\nContent-Type: application/x-ndjson\r\n"
                b"Transfer-Encoding: chunked\r\nConnection: close\r\n\r\n"
            )

            def chunk(line: str) -> None:
                data = line.encode("utf-8")
                writer.write(f"{len(data):x}\r\n".encode() + data + b"\r\n")

            def send(frame: dict) -> None:
                line = _event_line(frame)
                if line is not None:
                    chunk(line)

            request = _parse(await reader.readexactly(length))
            chunk(_final_line(await service.handle(request, send), request))
            writer.write(b"0\r\n\r\n")
            await writer.drain()
        else:
            await respond(404, "text/plain", b"not a yea endpoint")
    except (ConnectionError, asyncio.IncompleteReadError, ValueError):
        pass
    finally:
        writer.close()


async def serve_http(
    service: Service, host: str = "127.0.0.1", port: int = 8080, path: str = "/yea"
) -> asyncio.base_events.Server:
    """Start the HTTP bridge: ``POST path`` takes one frame and streams NDJSON back;
    ``GET path`` or ``GET /.well-known/yea`` returns the BRIEF (plus ``endpoint``)."""
    return await asyncio.start_server(lambda r, w: _http_conn(service, path, r, w), host, port, limit=MAX_FRAME + 2)
