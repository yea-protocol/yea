"""Serve the Python example calendar (the same service as ../../examples/calendar.ts).

    YEA_TRUST=ed25519:... uv run python examples/serve.py
    calendar → yea://127.0.0.1:7457  and  http://127.0.0.1:8457/yea

YEA_TRUST is a comma-separated list of trusted principal keys. YEA_PORT and YEA_HTTP_PORT
move the ports; 0 binds a free one, and the line printed on stderr names the ports actually
bound. --stdio serves NDJSON on stdin/stdout instead (for ``stdio:`` URLs).
"""

from __future__ import annotations

import asyncio
import os
import sys

from calendar_example import calendar

from yea import serve_http, serve_stdio, serve_tcp


def bound(server: asyncio.base_events.Server) -> str:
    """``host:port`` of the server's first socket, as bound. With port 0 and a name like
    ``localhost``, each address gets its own free port, so name the address, not ``HOST``."""
    host, port = server.sockets[0].getsockname()[:2]
    return f"[{host}]:{port}" if ":" in host else f"{host}:{port}"


async def main() -> None:
    trust = [k for k in os.environ.get("YEA_TRUST", "").split(",") if k]
    host = os.environ.get("HOST", "127.0.0.1")
    tcp_port = int(os.environ.get("YEA_PORT", "7457"))
    http_port = int(os.environ.get("YEA_HTTP_PORT", "8457"))
    cal = calendar(trust)
    if "--stdio" in sys.argv:
        await serve_stdio(cal)
        return
    servers = [await serve_tcp(cal, host, tcp_port), await serve_http(cal, host, http_port)]
    tcp, http = (bound(s) for s in servers)
    print(
        f"yea python example up · calendar yea://{tcp} http://{http}/yea"
        f" · trusting {len(trust)} principal(s)",
        file=sys.stderr, flush=True,
    )
    await asyncio.gather(*(s.serve_forever() for s in servers))


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
