"""Opening a session from a URL: yea://, yeas://, http(s):// or stdio:<command>."""

from __future__ import annotations

import asyncio
import shlex
import ssl
from collections.abc import Sequence
from typing import Any
from urllib.parse import urlsplit

from ..grants import Grant
from ..keys import KeyPair
from ..transport import DEFAULT_PORT, MAX_FRAME, TLS_PORT
from .session import Client
from .transports import _HttpTransport, _StreamTransport


async def connect(
    url: str,
    *,
    key: KeyPair | str | bytes | None = None,
    grants: Sequence[str | Grant] = (),
    name: str = "agent",
    budget: int | None = None,
    ssl_context: ssl.SSLContext | None = None,
) -> Client:
    """Connect to ``yea://host[:port]``, ``yeas://…``, ``http(s)://…``, or
    ``stdio:<command>`` (spawns the command and speaks NDJSON over its stdin/stdout)."""
    if url.startswith("stdio:"):
        argv = shlex.split(url[len("stdio:"):])
        if not argv:
            raise ValueError("stdio: needs a command, e.g. stdio:python serve.py --stdio")
        proc = await asyncio.create_subprocess_exec(
            *argv, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, limit=MAX_FRAME + 2
        )
        transport: Any = _StreamTransport(proc.stdout, proc.stdin, proc)
    elif url.startswith(("http://", "https://")):
        transport = _HttpTransport(url)
    else:
        u = urlsplit(url)
        if u.scheme not in ("yea", "yeas"):
            raise ValueError(f"unsupported URL {url}")
        tls = u.scheme == "yeas"
        port = u.port or (TLS_PORT if tls else DEFAULT_PORT)
        ctx = (ssl_context or ssl.create_default_context()) if tls else None
        reader, writer = await asyncio.open_connection(u.hostname or "127.0.0.1", port, ssl=ctx, limit=MAX_FRAME + 2)
        transport = _StreamTransport(reader, writer)
    return Client(transport, key, grants, name, budget)
