"""``yea_mcp.http``: a Streamable HTTP front end for an MCP server that serves one person
(SPEC-mcp-py, "HTTP serves one person in v0"), as mcp-ts's ``@yea-protocol/mcp/http``. Every
request carries a bearer token (``YEA_HTTP_TOKEN``), and a request that has it is that person
(``YEA_SUB``): ``token_subject`` returns their ``sub``. Anything else is refused before the MCP
handler sees it, and on loopback so is a foreign Host (421) or Origin (403). It wraps the SDK's
own Streamable HTTP app, which caps the request body (413)."""

from __future__ import annotations

import hashlib
import hmac
import json
import os
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit

from mcp.server.auth.middleware.auth_context import auth_context_var
from mcp.server.auth.middleware.bearer_auth import AuthenticatedUser
from mcp.server.auth.provider import AccessToken
from starlette.datastructures import Headers

MAX_BODY = 1 << 20  # the largest request body served by default: 1 MiB, the same cap as a YEA frame
LOOPBACK_HOSTS = ("localhost", "127.0.0.1", "[::1]")

Scope = dict[str, Any]
ASGIApp = Callable[[Scope, Any, Any], Awaitable[None]]


@dataclass(frozen=True)
class HttpAuth:
    token: str  # the bearer token every request must carry: at least 32 characters
    sub: str  # who a request with that token is


@dataclass(frozen=True)
class Refusal:
    """A response the gate sends instead of letting a request through."""

    status: int
    body: bytes
    headers: tuple[tuple[bytes, bytes], ...] = ((b"content-type", b"application/json"),)


def http_auth_from(env: Mapping[str, str] = os.environ) -> HttpAuth:
    """The HTTP settings from the environment; raises ValueError, saying what's missing."""
    token, sub = env.get("YEA_HTTP_TOKEN", ""), env.get("YEA_SUB", "")
    if len(token) < 32 or not token.isascii():
        raise ValueError("--http needs YEA_HTTP_TOKEN, a bearer token of at least 32 characters that every request "
                         "must carry")
    if not sub:
        raise ValueError("--http needs YEA_SUB, the identity of the one person this server acts for")
    return HttpAuth(token, sub)


def _host_refusal(host: str | None) -> Refusal | None:
    """Against DNS rebinding: a loopback server answers only to a loopback Host. The messages are
    the TypeScript SDK's; the status is 421 Misdirected Request, as the Python SDK answers."""
    if not host:
        why = "Missing Host header"
    elif any(c in host for c in "@/?#"):  # userinfo or a path: never a Host a browser sends
        why = f"Invalid Host header: {host}"
    else:
        try:
            parts = urlsplit(f"http://{host}")
            _ = parts.port  # an invalid port is an invalid header
            name = parts.hostname or ""
        except ValueError:
            name, why = "", f"Invalid Host header: {host}"
        else:
            name = f"[{name}]" if ":" in name else name  # an IPv6 address, bracketed as a URL has it
            why = "" if name in LOOPBACK_HOSTS else f"Invalid Host: {name}"
    return _jsonrpc_refusal(421, why) if why else None


def _origin_refusal(origin: str | None) -> Refusal | None:
    """A browser page elsewhere: a loopback server answers only to a loopback Origin (403). No
    Origin passes, since only browsers send one; ``null`` and anything unparseable are refused. The
    messages are the TypeScript SDK's (``validateOriginHeader``)."""
    if not origin:
        return None
    try:
        parts = urlsplit(origin)
        _ = parts.port  # an invalid port is an invalid header
        name = (parts.hostname or "") if parts.scheme else ""
    except ValueError:
        name = ""
    if not name:
        return _jsonrpc_refusal(403, f"Invalid Origin header: {origin}")
    name = f"[{name}]" if ":" in name else name
    return None if name in LOOPBACK_HOSTS else _jsonrpc_refusal(403, f"Invalid Origin: {name}")


def _jsonrpc_refusal(status: int, why: str) -> Refusal:
    body = {"jsonrpc": "2.0", "error": {"code": -32000, "message": why}, "id": None}
    return Refusal(status, json.dumps(body, separators=(",", ":")).encode())


def _digest(s: str) -> bytes:
    return hashlib.sha256(s.encode("utf-8", "surrogateescape")).digest()


UNAUTHORIZED = Refusal(401, b'{"error":"invalid_token"}',
                       ((b"content-type", b"application/json"), (b"www-authenticate", b"Bearer")))


def http_gate(token: str, *, loopback: bool) -> Callable[[Scope], Refusal | None]:
    """The checks before anything else: on loopback the Host header (421) and the Origin header
    (403), then the bearer token, compared in constant time (401). None lets the request through."""
    def gate(scope: Scope) -> Refusal | None:
        headers = Headers(scope=scope)  # the first value of a repeated header wins, as in the SDK
        if loopback and (refused := _host_refusal(headers.get("host")) or _origin_refusal(headers.get("origin"))):
            return refused
        header = headers.get("authorization", "")
        given = header[len("Bearer "):] if header.startswith("Bearer ") else ""
        return None if given and hmac.compare_digest(_digest(given), _digest(token)) else UNAUTHORIZED

    return gate


async def _send(refusal: Refusal, send: Any) -> None:
    await send({"type": "http.response.start", "status": refusal.status, "headers": list(refusal.headers)})
    await send({"type": "http.response.body", "body": refusal.body})


def http_app(server: Any, auth: HttpAuth, *, loopback: bool = True, client_id: str = "yea-http",
             max_body: int = MAX_BODY) -> ASGIApp:
    """An ASGI app: ``http_gate``, then the SDK's Streamable HTTP app (``server.streamable_http_app``,
    which caps the body at ``max_body``: 413), with each request authenticated as ``auth.sub``, so
    ``yea(transport="http", sub=token_subject)`` sees that person."""
    gate = http_gate(auth.token, loopback=loopback)
    inner = server.streamable_http_app(max_request_body_size=max_body, host="127.0.0.1" if loopback else "0.0.0.0")
    user = AuthenticatedUser(AccessToken(token="verified", client_id=client_id, scopes=[], subject=auth.sub))

    async def app(scope: Scope, receive: Any, send: Any) -> None:
        if scope["type"] == "lifespan":  # the SDK's session manager starts and stops here
            await inner(scope, receive, send)
            return
        if scope["type"] != "http":  # a websocket (or anything else) never reaches the SDK: fail closed
            if scope["type"] == "websocket":
                await send({"type": "websocket.close", "code": 1008})
            return
        if refused := gate(scope):
            await _send(refused, send)
            return
        reset = auth_context_var.set(user)  # what get_access_token (and token_subject) read
        try:
            await inner({**scope, "user": user}, receive, send)
        finally:
            auth_context_var.reset(reset)

    return app


def serve_http(app: ASGIApp, *, host: str = "127.0.0.1", port: int = 8000, max_connections: int | None = None) -> None:
    """Serve ``app`` on ``host:port`` with uvicorn (an MCP SDK dependency) until the process ends.
    ``max_connections`` caps concurrent connections (uvicorn's ``limit_concurrency``). uvicorn has
    no timeout for reading a request, unlike mcp-ts's ``requestTimeout``, so serve anything but
    loopback behind a reverse proxy that has one."""
    import uvicorn

    uvicorn.run(app, host=host, port=port, log_level="warning", timeout_keep_alive=30,
                limit_concurrency=max_connections)
