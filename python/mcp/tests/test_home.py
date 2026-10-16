"""The ``home`` option (SPEC-mcp-py ``yea()``): ``policy.json``, the default store and the server key
live in it, and ``yea()`` resolves it once."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pytest
from conftest import PRINCIPAL, text
from mcp.server.mcpserver import MCPServer
from yea_mcp import yea

from mcp import Client
from yea import Plan, create, issue_grant

pytestmark = pytest.mark.anyio


@dataclass
class Server:
    approvals: Any
    server: MCPServer
    home: Path
    done: list[str] = field(default_factory=list)

    def deny(self, *names: str) -> None:
        (self.home / "policy.json").write_text(json.dumps({"deny": list(names)}))

    async def move(self) -> Any:
        async with Client(self.server, mode="auto") as c:
            return await c.call_tool("move", {"event": "e1"})


def serve(tmp_path: Path, name: str, **options: Any) -> Server:
    """A ``move`` job with a policy that lets it run, on a server whose home is ``tmp_path / name``."""
    home, policy = tmp_path / name, tmp_path / f"{name}.pg"
    approvals = yea(name="billing", transport="stdio", principal=PRINCIPAL.public, policy=str(policy),
                    **({"home": home} | options))
    s = Server(approvals, MCPServer("billing", request_state_security=approvals.request_state_security()), home)

    @approvals.job(s.server, risk="low", revert=lambda r, ctx: None)  # only an undoable job runs on its own
    async def move(event: str) -> list[Plan]:
        return [Plan(f"Move {event}", [create("event/1")], apply=lambda: s.done.append(event), undo_window=60)]

    policy.write_text(issue_grant(PRINCIPAL, approvals.service_id(), [{"can": ["move"]}, {"risk": "low"}]).encode())
    return s


async def test_two_servers_with_their_own_homes_read_their_own_deny_lists_and_stores(tmp_path, monkeypatch):
    monkeypatch.delenv("YEA_STORE", raising=False)  # with no store option either, each has <home>/store
    a, b = serve(tmp_path, "a"), serve(tmp_path, "b")
    a.deny("move")
    b.deny("something_else")
    refused = await a.move()
    assert refused.is_error and "your policy never allows move" in text(refused) and a.done == []
    in_b = (await b.move()).structured_content["receipt"]["id"]
    a.deny()  # policy.json is read on every call: lifting the deny applies at once
    in_a = (await a.move()).structured_content["receipt"]["id"]
    sa, sb = a.approvals._y.store, b.approvals._y.store
    assert Path(sa.root) == a.home / "store" and Path(sb.root) == b.home / "store"
    assert await sa.get_receipt(in_a) and await sb.get_receipt(in_b)
    assert await sa.get_receipt(in_b) is None and await sb.get_receipt(in_a) is None
    assert (a.home / "server" / "billing.key").exists() and (b.home / "server" / "billing.key").exists()


async def test_without_a_home_yea_takes_yea_home_once_at_start_up(tmp_path, monkeypatch):
    """The entry point's own default, so the env is the subject here."""
    monkeypatch.delenv("YEA_STORE", raising=False)
    monkeypatch.setenv("YEA_HOME", str(tmp_path / "a"))
    s = serve(tmp_path, "a", home=None)
    monkeypatch.setenv("YEA_HOME", str(tmp_path / "later"))
    s.deny("move")
    r = await s.move()
    assert r.is_error and "your policy never allows move" in text(r)
    assert (tmp_path / "a" / "server" / "billing.key").exists() and not (tmp_path / "later").exists()
