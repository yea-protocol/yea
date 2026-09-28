"""The approval core's security list, from the MCP side (SPEC-mcp-py, Testing)."""

from __future__ import annotations

import json

import httpx2
import mcp_types as t
import pytest
from mcp import Client
from mcp.client.streamable_http import streamable_http_client
from mcp.server.mcpserver import MCPServer
from yea import Plan, create, issue_grant
from yea.store import FileStore

from conftest import PRINCIPAL, Person, text
from yea_mcp import yea

pytestmark = pytest.mark.anyio


def consent_for(world, tool, plan_hash):
    sid = world.approvals.service_id()
    return issue_grant(PRINCIPAL, sid, [{"svc": [sid]}, {"verbs": ["COMMIT"]}, {"can": [tool]}, {"only": plan_hash},
                                        {"exp": 2**31}]).encode()


def jobs(world, done):
    ap, srv = world.approvals, world.server

    @ap.job(srv, risk="low")
    async def refund(amount: int) -> list[Plan]:
        return [Plan(f"Refund {amount}", [create("refund")], apply=lambda: done.append(("refund", amount))),
                Plan(f"Force refund {amount}", [create("refund")], risk="high", apply=lambda: done.append(("force", amount)))]

    @ap.job(srv, risk="low")
    async def move(event: str) -> list[Plan]:
        return [Plan(f"Move {event}", [create("e")], apply=lambda: done.append(("move", event)))]  # no undo window


async def plan_hashes(world, tool, args):
    async with world.client("auto") as c:
        r = await c.call_tool(tool, {**args, "preview": True})
    return [p["planHash"] for p in r.structured_content["plans"]]


async def test_a_denied_tool_never_runs_even_with_a_stored_consent(world):
    done = []
    jobs(world, done)
    (h, _) = await plan_hashes(world, "refund", {"amount": 5})
    await world.store.put_consent(h, consent_for(world, "refund", h))
    world.approvals._y.tighten = {"deny": ["refund"]}
    async with world.client("auto", Person()) as c:
        r = await c.call_tool("refund", {"amount": 5})
    assert r.is_error and done == []


async def test_a_high_plan_is_never_offered_in_the_form(world):
    done = []
    jobs(world, done)
    person = Person([{"plan": "anything", "confirm": "approve"}])
    async with world.client("auto", person) as c:
        await c.call_tool("refund", {"amount": 5})
    schema = person.seen[0].requested_schema
    assert "plan" not in schema["properties"]  # only the low plan is offered
    assert "Not offered here" in person.seen[0].message


async def test_an_irreversible_plan_never_auto_runs(world):
    done = []
    jobs(world, done)
    world.grant({"can": ["*"]}, {"risk": "high"})
    async with world.client("auto") as c:
        r = await c.call_tool("move", {"event": "e1"})
    assert r.is_error and "can't be undone" in text(r) and done == []


async def test_a_consent_for_one_plan_never_runs_another(world):
    done = []
    jobs(world, done)
    (h5, _) = await plan_hashes(world, "refund", {"amount": 5})
    (h6, _) = await plan_hashes(world, "refund", {"amount": 6})
    await world.store.put_consent(h6, consent_for(world, "refund", h5))
    async with world.client("auto") as c:
        r = await c.call_tool("refund", {"amount": 6})
    assert r.is_error and done == []


async def test_a_stored_copy_of_the_policy_grant_never_counts_as_a_consent(world):
    done = []
    jobs(world, done)
    (h, _) = await plan_hashes(world, "refund", {"amount": 5})
    await world.store.put_consent(h, issue_grant(PRINCIPAL, world.approvals.service_id(), [{"can": ["*"]}]).encode())
    async with world.client("auto") as c:
        r = await c.call_tool("refund", {"amount": 5})
    assert r.is_error and done == []


async def test_a_request_state_that_isnt_ours_is_refused(world):
    done = []
    jobs(world, done)
    async with world.client("auto") as c:
        foreign = await c.session.call_tool("refund", {"amount": 5}, input_responses={}, request_state=None,
                                            allow_input_required=True)
        assert foreign.is_error  # no elicitation: consent codes, nothing run
    # A state the SDK sealed for us but without our `yea` object.
    from yea_mcp.ask import parse_state

    assert parse_state(json.dumps({"other": 1}))[0] == "foreign" and parse_state("not json")[0] == "foreign"
    assert done == []


async def test_a_guarded_original_never_runs_before_approval(world):
    calls = []

    @world.server.tool()
    async def wipe(target: str) -> str:
        calls.append(target)
        return "wiped"

    world.approvals.guard(world.server, "wipe", describe=lambda a: {"summary": "Wipe", "effects": [], "risk": "low"})
    async with world.client("auto", Person(["decline"])) as c:
        await c.call_tool("wipe", {"target": "db"})
    async with world.client("auto") as c:
        await c.call_tool("wipe", {"target": "db"})
    assert calls == []


async def test_legacy_stateless_http_takes_the_consent_code_path(tmp_path, monkeypatch):
    monkeypatch.setenv("YEA_HOME", str(tmp_path))
    done = []
    ap = yea(name="s", transport="http", sub=lambda r: "person", store=FileStore(tmp_path / "st"),
             server_key=tmp_path / "k", principal=PRINCIPAL.public)
    srv = MCPServer("s", request_state_security=ap.request_state_security())

    @ap.job(srv, risk="low")
    async def send(to: str) -> list[Plan]:
        return [Plan(f"Send to {to}", [create("mail/x")], apply=lambda: done.append(to))]

    app = srv.streamable_http_app(stateless_http=True)
    async with app.router.lifespan_context(app):
        async with httpx2.AsyncClient(transport=httpx2.ASGITransport(app=app), base_url="http://127.0.0.1:8000") as http:
            async with Client(streamable_http_client("http://127.0.0.1:8000/mcp", http_client=http), mode="legacy",
                              elicitation_callback=Person()) as c:
                r = await c.call_tool("send", {"to": "ana"})
    assert r.is_error and "yea approve" in text(r) and done == []
