"""yea_mcp.http: the HTTP front end for one person, as mcp-ts's @yea-protocol/mcp/http (#176)."""

from __future__ import annotations

import asyncio
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
        async with httpx2.AsyncClient(headers={"Authorization": f"Bearer {TOKEN}"}) as hc:
            async with Client(streamable_http_client(url, http_client=hc)) as c:
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
