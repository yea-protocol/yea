"""The start-up and per-call refusals, token_subject, the 2025 back-channel, and the key and store checks (SPEC-mcp-py)."""

from __future__ import annotations

import asyncio
import os

import pytest
import yea_mcp
from conftest import PRINCIPAL, Person, text
from mcp.server.mcpserver import MCPServer
from mcp.shared.exceptions import NoBackChannelError
from yea_mcp import token_subject, yea

from mcp import Client
from yea import Plan, create
from yea.store import FileStore, MemoryStore

pytestmark = pytest.mark.anyio


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


def test_the_server_key_directory_and_file_are_checked(tmp_path, monkeypatch):
    monkeypatch.setenv("YEA_HOME", str(tmp_path))
    open_dir = tmp_path / "open"
    open_dir.mkdir(mode=0o777)
    os.chmod(open_dir, 0o777)
    with pytest.raises(ValueError, match="writable by no one else"):
        yea(name="s", transport="stdio", server_key=open_dir / "k.key")
    good = tmp_path / "good"
    ap = yea(name="s", transport="stdio", server_key=good / "k.key")
    assert (good.stat().st_mode & 0o777) == 0o700 and ((good / "k.key").stat().st_mode & 0o777) == 0o600
    assert yea(name="s", transport="stdio", server_key=good / "k.key").service_id() == ap.service_id()
    assert not list(good.glob("*.tmp"))


def test_a_key_directory_whose_parent_its_group_can_write_is_refused(tmp_path, monkeypatch):
    """A group member who can write the parent could swap the key directory, so it's refused as in
    mcp-ts (& 0o022); a sticky parent, like /tmp, is still fine."""
    monkeypatch.setenv("YEA_HOME", str(tmp_path))
    shared = tmp_path / "shared"
    shared.mkdir()
    os.chmod(shared, 0o775)
    with pytest.raises(ValueError, match="can be changed by other users"):
        yea(name="s", transport="stdio", server_key=shared / "keys" / "k.key")
    os.chmod(shared, 0o1775)
    assert yea(name="s", transport="stdio", server_key=shared / "sticky" / "k.key").service_id()


def test_a_memory_store_subclass_is_still_a_memory_store(tmp_path, monkeypatch):
    monkeypatch.setenv("YEA_HOME", str(tmp_path))

    class CountingStore(MemoryStore):
        pass

    with pytest.raises(ValueError, match="single_process"):
        yea(name="s", transport="http", sub=lambda r: "me", store=CountingStore(), server_key=tmp_path / "k")
    with pytest.raises(ValueError, match="shared state_key"):
        yea(name="s", transport="stdio", store=CountingStore(), state_key=b"k" * 32, server_key=tmp_path / "k")


def test_the_default_store_reads_yea_store_before_yea_home(tmp_path, monkeypatch):
    """As mcp-ts's defaultFileStore: YEA_STORE, else $YEA_HOME/store, so `yea approve` and the
    server agree on where consents go (#148)."""
    monkeypatch.setenv("YEA_HOME", str(tmp_path / "home"))
    monkeypatch.setenv("YEA_STORE", str(tmp_path / "shared"))
    assert str(yea(name="s", transport="stdio")._y.store.root) == str(tmp_path / "shared")
    monkeypatch.setenv("YEA_STORE", "")  # empty counts as unset
    assert str(yea(name="s", transport="stdio")._y.store.root) == str(tmp_path / "home" / "store")


async def test_a_memory_store_says_why_no_consent_code_and_what_to_do(tmp_path, monkeypatch):
    """The same words as mcp-ts: where `yea approve` can't reach, and the two ways out (#145)."""
    monkeypatch.setenv("YEA_HOME", str(tmp_path))
    monkeypatch.delenv("YEA_POLICY", raising=False)  # no policy: the job asks, and this client can't
    mem = yea(name="m", transport="stdio", store=MemoryStore(), server_key=tmp_path / "m", principal=PRINCIPAL.public)
    srv = MCPServer("m", request_state_security=mem.request_state_security())

    @mem.job(srv, risk="low")
    async def move(event: str) -> list[Plan]:
        return [Plan(f"Move {event}", [create("e")], apply=lambda: None)]

    async with Client(srv, mode="auto") as c:  # a client that can't show forms
        r = await c.call_tool("move", {"event": "e1"})
    assert r.is_error and ("this server keeps approvals in memory, where `yea approve` can't reach them; use a "
                           "client that can show approval forms, or run the server with a FileStore") in text(r)


def test_a_fresh_yea_home_is_private_under_a_group_umask(tmp_path, monkeypatch):
    """Under umask 002 (the default for users with their own group on Debian and Ubuntu) every
    directory created on first run is 0700, as Node's recursive mkdir makes it, so the parent
    check doesn't refuse the ~/.yea it just made."""
    home = tmp_path / "home" / ".yea"
    monkeypatch.setenv("YEA_HOME", str(home))
    old = os.umask(0o002)
    try:
        yea(name="s", transport="stdio")
        assert asyncio.run(FileStore(tmp_path / "a" / "b" / "store").consume_once("x", 2**31))
    finally:
        os.umask(old)
    for d in (home, home / "server", tmp_path / "a", tmp_path / "a" / "b" / "store" / "consumed"):
        assert (d.stat().st_mode & 0o777) == 0o700, d
