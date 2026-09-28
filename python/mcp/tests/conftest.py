"""Shared fixtures: a principal, a server with approvals, and in-memory clients of three kinds
(2026 that elicits, 2025-era that elicits, and one that can't elicit)."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Any

import mcp_types as t
import pytest
from mcp import Client
from mcp.server.mcpserver import MCPServer
from yea import issue_grant, key_from_seed
from yea.store import MemoryStore

from yea_mcp import yea

PRINCIPAL = key_from_seed(bytes([7]) * 32)
STRANGER = key_from_seed(bytes([9]) * 32)
MODES = ["auto", "legacy"]  # 2026-07-28, and the 2025 era


@dataclass
class Person:
    """Answers forms: types each queued phrase in turn (or declines/cancels)."""

    answers: list[Any] = field(default_factory=list)
    seen: list[Any] = field(default_factory=list)

    async def __call__(self, ctx: Any, params: Any) -> t.ElicitResult:
        self.seen.append(params)
        a = self.answers.pop(0) if self.answers else "approve"
        if a in ("decline", "cancel"):
            return t.ElicitResult(action=a)
        if isinstance(a, dict):
            return t.ElicitResult(action="accept", content=a)
        return t.ElicitResult(action="accept", content={"confirm": a})


@dataclass
class World:
    approvals: Any
    server: MCPServer
    store: MemoryStore
    home: str

    def grant(self, *caveats: dict, principal: Any = PRINCIPAL) -> None:
        """Install a signed policy grant, issued to this server's key."""
        os.environ["YEA_POLICY"] = issue_grant(principal, self.approvals.service_id(), list(caveats)).encode()

    def client(self, mode: str, person: Person | None = None) -> Client:
        if person is None:
            return Client(self.server, mode=mode)
        return Client(self.server, mode=mode, elicitation_callback=person)


@pytest.fixture
def world(tmp_path: Any, monkeypatch: pytest.MonkeyPatch) -> World:
    monkeypatch.setenv("YEA_HOME", str(tmp_path / "home"))
    monkeypatch.delenv("YEA_POLICY", raising=False)
    monkeypatch.delenv("YEA_PRINCIPAL_PUB", raising=False)
    store = MemoryStore()
    approvals = yea(name="billing", transport="stdio", store=store, single_process=True,
                    server_key=tmp_path / "server.key", principal=PRINCIPAL.public)
    server = MCPServer("billing", request_state_security=approvals.request_state_security())
    return World(approvals, server, store, str(tmp_path / "home"))


def text(r: Any) -> str:
    return "\n".join(c.text for c in r.content if getattr(c, "type", "") == "text")


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"
