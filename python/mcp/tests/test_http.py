"""yea_mcp.http: the HTTP front end for one person, as mcp-ts's @yea-protocol/mcp/http (#176)."""

from __future__ import annotations

import asyncio
import json
import socket
import threading
import time
from contextlib import contextmanager

import httpx2
import pytest
import uvicorn
from mcp import Client
from mcp.client.streamable_http import streamable_http_client
from mcp.server.mcpserver import MCPServer
from yea import Plan, create, issue_grant
from yea.store import MemoryStore

from conftest import PRINCIPAL
from yea_mcp import token_subject, yea
from yea_mcp.http import MAX_BODY, HttpAuth, http_app, http_auth_from, http_gate

TOKEN = "t" * 40


def test_http_auth_from_says_whats_missing():
    with pytest.raises(ValueError, match="YEA_HTTP_TOKEN, a bearer token of at least 32 characters"):
        http_auth_from({"YEA_HTTP_TOKEN": "short", "YEA_SUB": "alice"})
    with pytest.raises(ValueError, match="YEA_SUB, the identity of the one person"):
        http_auth_from({"YEA_HTTP_TOKEN": TOKEN})
    assert http_auth_from({"YEA_HTTP_TOKEN": TOKEN, "YEA_SUB": "alice"}) == HttpAuth(TOKEN, "alice")


def scope(**headers):
    return {"type": "http", "headers": [(k.replace("_", "-").encode(), v.encode()) for k, v in headers.items()]}


def test_the_gate_checks_host_then_the_token():
    gate = http_gate(TOKEN, loopback=True)
    ok = f"Bearer {TOKEN}"
    assert gate(scope(host="127.0.0.1:8000", authorization=ok)) is None
    assert gate(scope(host="evil.example", authorization=ok)).status == 421  # DNS rebinding
    assert gate(scope(host="evil.example")).status == 421  # the Host is checked before the token
    no = gate(scope(host="localhost"))
    assert no.status == 401 and (b"www-authenticate", b"Bearer") in no.headers
    assert gate(scope(host="localhost", authorization="Bearer " + "x" * 40)).status == 401
    assert gate(scope(host="localhost", authorization=TOKEN)).status == 401  # not a Bearer header
    assert http_gate(TOKEN, loopback=False)(scope(host="api.example", authorization=ok)) is None  # off loopback


def test_on_loopback_the_gate_refuses_a_foreign_origin_after_the_host_and_before_the_token():
    """As mcp-ts's httpGate: Host (421), then Origin (403, a JSON-RPC error), then the token (401).
    No Origin passes (only browsers send one); `null` and anything unparseable are refused."""
    gate = http_gate(TOKEN, loopback=True)
    ok = f"Bearer {TOKEN}"
    for origin in ("http://localhost", "http://localhost:5173", "https://localhost:8443", "http://127.0.0.1:8787",
                   "http://[::1]:3000"):
        assert gate(scope(host="localhost:8787", origin=origin, authorization=ok)) is None, origin
    assert gate(scope(host="localhost:8787", authorization=ok)) is None
    refusals = {
        "https://evil.example": "Invalid Origin: evil.example",
        "http://localhost.evil.example:8787": "Invalid Origin: localhost.evil.example",
        "http://127.0.0.1.evil.example": "Invalid Origin: 127.0.0.1.evil.example",
        "http://[::2]:3000": "Invalid Origin: [::2]",
        "null": "Invalid Origin header: null",
        "localhost": "Invalid Origin header: localhost",
        "http://[::1": "Invalid Origin header: http://[::1",
        "http://localhost:99999": "Invalid Origin header: http://localhost:99999",
    }
    for origin, message in refusals.items():
        no = gate(scope(host="localhost", origin=origin, authorization=ok))
        assert no is not None and no.status == 403, origin
        assert json.loads(no.body) == {"jsonrpc": "2.0", "error": {"code": -32000, "message": message}, "id": None}
    evil = "https://evil.example"
    assert gate(scope(host="evil.example", origin=evil)).status == 421
    assert gate(scope(host="localhost", origin=evil)).status == 403  # before the token
    assert gate(scope(host="localhost", origin="http://localhost:1")).status == 401
    assert http_gate(TOKEN, loopback=False)(scope(host="api.example", origin=evil, authorization=ok)) is None


@contextmanager
def serving(app):
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning", lifespan="on"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    while not server.started:
        time.sleep(0.02)
    try:
        yield f"http://127.0.0.1:{port}/mcp"
    finally:
        server.should_exit = True
        thread.join(5)


def test_end_to_end_the_person_is_the_tokens_sub_and_others_are_refused(tmp_path, monkeypatch):
    monkeypatch.setenv("YEA_HOME", str(tmp_path))
    done = []
    ap = yea(name="h", transport="http", sub=token_subject, store=MemoryStore(), single_process=True,
             server_key=tmp_path / "k", principal=PRINCIPAL.public)
    srv = MCPServer("h", request_state_security=ap.request_state_security())

    @srv.tool()
    async def who() -> str:
        return token_subject()

    @ap.job(srv, risk="low", revert=lambda r, ctx: None)
    async def move(event: str) -> list[Plan]:
        return [Plan(f"Move {event}", [create("event/1")], apply=lambda: done.append(event), undo_window=60)]

    monkeypatch.setenv("YEA_POLICY", issue_grant(PRINCIPAL, ap.service_id(), [{"can": ["move"]}, {"risk": "low"}]).encode())

    async def go(url):
        hc = httpx2.AsyncClient(headers={"Authorization": f"Bearer {TOKEN}"})
        async with hc, Client(streamable_http_client(url, http_client=hc)) as c:
            assert (await c.call_tool("who", {})).content[0].text == "alice"
            r = await c.call_tool("move", {"event": "e1"})
            assert not r.is_error and r.structured_content["receipt"]["sub"] == "alice"
        async with httpx2.AsyncClient() as hc:
            assert (await hc.post(url, json={})).status_code == 401
            assert (await hc.post(url, json={}, headers={"Host": "evil.example"})).status_code == 421
            big = await hc.post(url, content=b"x" * (MAX_BODY + 1), headers={"Authorization": f"Bearer {TOKEN}",
                                                                             "Content-Type": "application/json"})
            assert big.status_code == 413

    with serving(http_app(srv, HttpAuth(TOKEN, "alice"))) as url:
        asyncio.run(go(url))
    assert done == ["e1"]


def test_a_websocket_or_other_scope_never_reaches_the_sdk_app():
    """Only lifespan passes through ungated; a websocket is closed and anything else dropped (fail closed)."""
    reached, sent = [], []

    class Stub:
        def streamable_http_app(self, **kw):
            async def inner(scope, receive, send):
                reached.append(scope["type"])
            return inner

    async def send(message):
        sent.append(message)

    async def go():
        app = http_app(Stub(), HttpAuth(TOKEN, "alice"))
        for kind in ("websocket", "something-new", "lifespan"):
            await app({"type": kind, "headers": []}, None, send)

    asyncio.run(go())
    assert reached == ["lifespan"] and sent == [{"type": "websocket.close", "code": 1008}]


def test_the_gate_refuses_a_host_with_userinfo_or_a_path_and_a_non_ascii_token():
    gate = http_gate(TOKEN, loopback=True)
    for host in ("evil@localhost:8000", "localhost/x", "localhost?x", "localhost#x"):
        assert gate(scope(host=host, authorization=f"Bearer {TOKEN}")).status == 421, host
    with pytest.raises(ValueError, match="YEA_HTTP_TOKEN"):
        http_auth_from({"YEA_HTTP_TOKEN": "é" * 40, "YEA_SUB": "alice"})


def test_off_loopback_a_public_host_is_served_and_on_loopback_a_foreign_origin_is_not(tmp_path, monkeypatch):
    """loopback=False turns the SDK's Host check off too (else every public Host would get its 421);
    on loopback a foreign Origin gets the gate's 403, before the token is even checked."""
    monkeypatch.setenv("YEA_HOME", str(tmp_path))

    def server():
        srv = MCPServer("h")

        @srv.tool()
        async def who() -> str:
            return token_subject()
        return srv

    init = {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
        "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "t", "version": "1"}}}
    headers = {"Authorization": f"Bearer {TOKEN}", "Accept": "application/json, text/event-stream"}

    async def post(url, **extra):
        async with httpx2.AsyncClient() as hc:
            return (await hc.post(url, json=init, headers={**headers, **extra})).status_code

    with serving(http_app(server(), HttpAuth(TOKEN, "alice"), loopback=False)) as url:
        assert asyncio.run(post(url, Host="mcp.example.com")) == 200
    with serving(http_app(server(), HttpAuth(TOKEN, "alice"))) as url:
        assert asyncio.run(post(url, Origin="https://evil.example")) == 403
        assert asyncio.run(post(url, Origin="https://evil.example", Authorization="Bearer nope")) == 403
        assert asyncio.run(post(url, Origin="http://127.0.0.1:5173")) == 200
