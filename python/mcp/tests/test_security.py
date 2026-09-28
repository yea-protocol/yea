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


async def test_a_high_plan_is_never_offered_in_the_form_and_cant_be_chosen(world):
    done = []
    jobs(world, done)
    (_, high) = await plan_hashes(world, "refund", {"amount": 5})
    person = Person([{"plan": high, "confirm": "approve"}])
    async with world.client("auto", person) as c:
        r = await c.call_tool("refund", {"amount": 5})
    schema = person.seen[0].requested_schema
    assert "plan" not in schema["properties"]  # only the low plan is offered
    assert "Not offered here" in person.seen[0].message
    assert r.is_error and ("force", 5) not in done


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


async def test_a_verified_state_without_yea_is_refused(world, monkeypatch):
    """A state the SDK sealed for this very tool and input, but that isn't our approval."""
    done = []
    jobs(world, done)
    import yea_mcp.call as call_mod

    real = call_mod.input_required
    monkeypatch.setattr(call_mod, "input_required", lambda form, state: t.InputRequiredResult(
        input_requests=real(form, state).input_requests, request_state=json.dumps({"other": state})))
    async with world.client("auto", Person()) as c:
        first = await c.session.call_tool("refund", {"amount": 5}, allow_input_required=True)
        assert isinstance(first, t.InputRequiredResult)
        answer = {"yea": t.ElicitResult(action="accept", content={"confirm": "approve"})}
        r = await c.session.call_tool("refund", {"amount": 5}, input_responses=answer,
                                      request_state=first.request_state, allow_input_required=True)
    assert r.is_error and "belongs to something else" in text(r) and done == []


async def test_another_jobs_state_is_refused(world):
    done = []
    jobs(world, done)

    @world.approvals.job(world.server, risk="low")
    async def refund_other(amount: int) -> list[Plan]:
        return [Plan("Other", [create("x")], apply=lambda: done.append("other"))]

    from mcp.shared.exceptions import MCPError
    from yea.approval import check_state

    async with world.client("auto", Person()) as c:
        first = await c.session.call_tool("refund", {"amount": 5}, allow_input_required=True)
        answer = {"yea": t.ElicitResult(action="accept", content={"confirm": "approve"})}
        with pytest.raises(MCPError):  # the SDK's binding: the state was sealed for another tool
            await c.session.call_tool("refund_other", {"amount": 5}, input_responses=answer,
                                      request_state=first.request_state, allow_input_required=True)
    assert done == [] and not first.request_state.startswith("{")  # sealed on the wire, never our plaintext
    # And our own check, should a state ever get past the binding: it names its tool.
    from yea.approval import input_hash, new_state

    ours = new_state("refund", input_hash({"amount": 5}), "", ["h"], 1, 1_790_000_000)
    assert check_state(ours, "refund_other", input_hash({"amount": 5}), "", 1_790_000_000) is None


async def test_a_state_replayed_by_another_caller_is_refused(tmp_path, monkeypatch):
    import contextvars

    monkeypatch.setenv("YEA_HOME", str(tmp_path))
    who = contextvars.ContextVar("who", default="alice")
    done = []
    ap = yea(name="s", transport="http", sub=lambda r: who.get(), store=FileStore(tmp_path / "st"),
             server_key=tmp_path / "k", principal=PRINCIPAL.public)
    srv = MCPServer("s", request_state_security=ap.request_state_security())

    @ap.job(srv, risk="low")
    async def send(to: str) -> list[Plan]:
        return [Plan(f"Send to {to}", [create("mail/x")], apply=lambda: done.append(to))]

    async with Client(srv, mode="auto", elicitation_callback=Person()) as c:
        first = await c.session.call_tool("send", {"to": "ana"}, allow_input_required=True)
        who.set("bob")
        answer = {"yea": t.ElicitResult(action="accept", content={"confirm": "approve"})}
        r = await c.session.call_tool("send", {"to": "ana"}, input_responses=answer,
                                      request_state=first.request_state, allow_input_required=True)
    assert r.is_error and "invalid, expired, already used, or for another call" in text(r) and done == []


async def test_a_client_that_claims_elicitation_but_cant_answer_gets_codes(world):
    done = []
    jobs(world, done)

    async def broken(ctx, params):
        raise RuntimeError("no UI here")

    async with world.client("legacy", broken) as c:
        r = await c.call_tool("refund", {"amount": 5})
    assert r.is_error and "yea approve" in text(r) and done == []


async def test_the_fastmcp_guard_cant_be_skipped_by_a_hashed_name(world):
    from fastmcp import Client as FastClient
    from fastmcp import FastMCP
    from fastmcp.apps.app import FastMCPApp
    from fastmcp.server.providers.addressing import hash_tool

    fm = FastMCP("b", request_state_security=world.approvals.request_state_security())
    app = FastMCPApp("dash")
    calls = []

    @app.tool(model=True)
    def wipe(target: str) -> str:
        calls.append(target)
        return "wiped " + target

    fm.add_provider(app)
    world.approvals.guard(fm, "wipe", describe=lambda a: {"summary": "Wipe", "effects": [], "risk": "low"})
    async with FastClient(fm) as c:
        by_name = await c.call_tool("wipe", {"target": "db"}, raise_on_error=False)
        by_hash = await c.call_tool(hash_tool("dash", "wipe") + "_wipe", {"target": "db"}, raise_on_error=False)
    assert by_name.is_error and by_hash.is_error and calls == []


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


async def test_a_namespaced_copy_of_a_guarded_fastmcp_tool_is_refused(world):
    from fastmcp import Client as FastClient
    from fastmcp import FastMCP
    from fastmcp.server.transforms import Namespace

    fm = FastMCP("b", request_state_security=world.approvals.request_state_security())
    calls = []

    @fm.tool
    def wipe(target: str) -> str:
        calls.append(target)
        return "wiped"

    world.approvals.guard(fm, "wipe", describe=lambda a: {"summary": "Wipe", "effects": [], "risk": "low"})
    fm.add_transform(Namespace("x"))
    async with FastClient(fm) as c:
        r = await c.call_tool("x_wipe", {"target": "db"}, raise_on_error=False)
    assert r.is_error and "under another name" in text(r) and calls == []


async def test_a_failing_original_with_a_broken_store_is_still_its_own_error(world):
    import mcp_types as mt

    calls = []

    @world.server.tool()
    async def charge(cents: int) -> str:
        calls.append(cents)
        raise RuntimeError("card declined")

    world.approvals.guard(world.server, "charge", revert=lambda r, ctx: None,
                          describe=lambda a: {"summary": "Charge", "effects": [], "risk": "low", "undo_window": 60,
                                              "uses": {"spend": {"amount": a["cents"], "scale": 2, "unit": "USD"}}})
    world.grant({"can": ["charge"]}, {"total": {"of": "spend", "max": 10000, "scale": 2, "unit": "USD"}})

    async def broken(r):
        raise OSError("disk full")

    world.store.release = broken
    async with world.client("auto", Person()) as c:
        r = await c.call_tool("charge", {"cents": 500})
    assert r.is_error and "happened" not in text(r) and calls == [500]
    assert isinstance(r, mt.CallToolResult)
