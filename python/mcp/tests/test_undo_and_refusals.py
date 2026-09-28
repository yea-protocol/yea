"""undo, the start-up and per-call refusals, token_subject and the 2025 back-channel (SPEC-mcp-py)."""

from __future__ import annotations

import os
import time

import pytest
from mcp.server.mcpserver import MCPServer
from mcp.shared.exceptions import NoBackChannelError
from yea import Plan, create
from yea.store import FileStore, MemoryStore

import yea_mcp
from conftest import MODES, PRINCIPAL, Person, text
from yea_mcp import token_subject, yea

pytestmark = pytest.mark.anyio


def movable(world, done):
    @world.approvals.job(world.server, risk="low", revert=lambda r, ctx: done.append(("revert", r["input"], r["result"])))
    async def move(event: str) -> list[Plan]:
        return [Plan(f"Move {event}", [create(f"event/{event}")], apply=lambda: {"moved": event}, undo_window=60)]


@pytest.mark.parametrize("mode", MODES)
async def test_undo_within_the_window_then_refuses(world, mode, monkeypatch):
    done = []
    movable(world, done)
    world.grant({"can": ["move"]})
    async with world.client(mode, Person()) as c:
        rid = (await c.call_tool("move", {"event": "e1"})).structured_content["receipt"]["id"]
        ok = await c.call_tool("undo", {"receipt": rid})
        again = await c.call_tool("undo", {"receipt": rid})
        bad = await c.call_tool("undo", {"receipt": "../x"})
    assert not ok.is_error and text(ok).startswith(f"↶ undid {rid}")
    assert done == [("revert", {"event": "e1"}, {"moved": "e1"})]
    assert again.is_error and "already undone" in text(again) and bad.is_error and "no such receipt" in text(bad)


async def test_undo_refuses_after_the_window_for_another_sub_and_another_server(world, monkeypatch):
    done = []
    movable(world, done)
    world.grant({"can": ["move"]})
    async with world.client("auto", Person()) as c:
        rids = [(await c.call_tool("move", {"event": f"e{i}"})).structured_content["receipt"]["id"] for i in range(3)]
    receipt = await world.store.get_receipt(rids[0])
    receipt["undo"]["until"] = int(time.time()) - 1
    await world.store.put_receipt(receipt)
    other_sub = await world.store.get_receipt(rids[1])
    await world.store.put_receipt({**other_sub, "sub": "someone-else"})
    other_server = await world.store.get_receipt(rids[2])
    await world.store.put_receipt({**other_server, "service": "ed25519:other"})
    async with world.client("auto", Person()) as c:
        closed, sub, server = [await c.call_tool("undo", {"receipt": r}) for r in rids]
    assert "window has closed" in text(closed) and "no such receipt" in text(sub) and "no such receipt" in text(server)
    assert done == []


def test_start_up_refusals(tmp_path, monkeypatch):
    monkeypatch.setenv("YEA_HOME", str(tmp_path))
    key = tmp_path / "k.key"
    with pytest.raises(ValueError, match="HTTP needs sub"):
        yea(name="s", transport="http", store=FileStore(tmp_path / "st"), server_key=key)
    with pytest.raises(ValueError, match="shared state_key needs a shared store"):
        yea(name="s", transport="stdio", store=MemoryStore(), state_key=b"k" * 32, server_key=key)
    with pytest.raises(ValueError, match="single_process"):
        yea(name="s", transport="http", sub=lambda r: "me", server_key=key)
    with pytest.raises(ValueError, match="name must match"):
        yea(name="Bad Name", transport="stdio", server_key=key)
    loose = tmp_path / "loose.key"
    loose.write_text("A" * 43 + "\n")
    os.chmod(loose, 0o644)
    with pytest.raises(ValueError, match="read by other users"):
        yea(name="s", transport="stdio", server_key=loose)
    link = tmp_path / "link.key"
    link.symlink_to(key)
    with pytest.raises(ValueError, match="symlink"):
        yea(name="s", transport="stdio", server_key=link)


async def test_per_call_refusals(tmp_path, monkeypatch):
    monkeypatch.setenv("YEA_HOME", str(tmp_path))
    from yea import issue_grant

    ap = yea(name="s", transport="http", sub=lambda r: "", store=FileStore(tmp_path / "st"), server_key=tmp_path / "k")
    srv = MCPServer("s", request_state_security=ap.request_state_security())

    @ap.job(srv, risk="low")
    async def job() -> list[Plan]:
        return [Plan("J", [], apply=lambda: None)]

    from mcp import Client

    async with Client(srv, mode="auto") as c:
        r = await c.call_tool("job", {})
    assert r.is_error and "no authenticated caller" in text(r)

    mem = yea(name="m", transport="stdio", store=MemoryStore(), server_key=tmp_path / "m", principal=PRINCIPAL.public)
    srv2 = MCPServer("m", request_state_security=mem.request_state_security())

    @mem.job(srv2, risk="low")
    async def job2() -> list[Plan]:
        return [Plan("J", [], apply=lambda: None)]

    monkeypatch.setenv("YEA_POLICY", issue_grant(PRINCIPAL, mem.service_id(), [{"can": ["*"]}, {"total": {"of": "x", "max": 1}}]).encode())
    async with Client(srv2, mode="auto") as c:
        r = await c.call_tool("job2", {})
    assert r.is_error and "total limit" in text(r)


def test_token_subject_is_empty_without_a_subject(monkeypatch):
    class Token:
        subject = None
        client_id = "app"

    monkeypatch.setattr(yea_mcp, "get_access_token", lambda: Token())
    assert token_subject() == ""
    Token.subject = "person-1"
    assert token_subject() == "person-1"
    monkeypatch.setattr(yea_mcp, "get_access_token", lambda: None)
    assert token_subject() == ""


async def test_the_2025_ask_fails_closed_without_a_back_channel(world, monkeypatch):
    done = []

    @world.approvals.job(world.server, risk="low")
    async def send(to: str) -> list[Plan]:
        return [Plan(f"Send to {to}", [create("mail/x")], apply=lambda: done.append(to))]

    async def no_channel(*a, **k):
        raise NoBackChannelError("elicitation/create")

    from mcp.server.session import ServerSession

    monkeypatch.setattr(ServerSession, "elicit_form", no_channel)
    async with world.client("legacy", Person()) as c:
        r = await c.call_tool("send", {"to": "ana"})
    assert r.is_error and "yea approve" in text(r) and done == []
