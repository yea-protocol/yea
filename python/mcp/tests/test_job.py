"""Jobs on MCPServer, for each client kind (SPEC-mcp-py, Testing)."""

from __future__ import annotations

import json
import os
from datetime import date
from enum import Enum

import mcp_types as t
import pytest
from pydantic import BaseModel, Field
from yea import Plan, create, decode_grant, issue_grant, quantity
from yea.store import LedgerKey

from conftest import MODES, PRINCIPAL, Person, text

pytestmark = pytest.mark.anyio


def register(world, done):
    ap, srv = world.approvals, world.server

    @ap.job(srv, risk="low", revert=lambda r, ctx: done.append(("revert", r["input"])))
    async def move(event: str) -> list[Plan]:
        """Move a meeting."""
        return [Plan(f"Move {event}", [create(f"event/{event}")], apply=lambda: done.append(("move", event)) or {"ok": 1},
                     undo_window=60, uses={"emails": quantity(1)})]

    @ap.job(srv, risk="low", confirm_with=lambda hp, i: i["to"])
    async def send(to: str) -> list[Plan]:
        """Send an email."""
        return [Plan(f"Send to {to}", [create(f"mail/{to}")], apply=lambda: done.append(("send", to)))]


@pytest.mark.parametrize("mode", MODES)
async def test_a_job_the_policy_allows_runs_once_and_settles_its_total(world, mode):
    done = []
    register(world, done)
    world.grant({"can": ["move"]}, {"risk": "low"}, {"total": {"of": "emails", "max": 5}})
    async with world.client(mode, Person()) as c:
        r = await c.call_tool("move", {"event": "e1"})
    assert not r.is_error and "Move e1" in text(r) and done == [("move", "e1")]
    receipt = r.structured_content["receipt"]
    assert receipt["service"] == world.approvals.service_id() and receipt["undo"] is not None
    block = decode_grant(os.environ["YEA_POLICY"]).id
    assert await world.store.used(LedgerKey(block, "emails")) == 10**18


@pytest.mark.parametrize("mode", MODES)
async def test_outside_the_policy_it_asks_and_the_phrase_runs_it(world, mode):
    done = []
    register(world, done)
    person = Person(["bo", "ana"])  # wrong, then right
    async with world.client(mode, person) as c:
        r = await c.call_tool("send", {"to": "ana"})
    assert not r.is_error and done == [("send", "ana")]
    assert len(person.seen) == 2 and person.seen[0].requested_schema["properties"]["confirm"]["description"] == 'Type "ana" to approve.'


@pytest.mark.parametrize("mode", MODES)
async def test_three_wrong_phrases_refuse(world, mode):
    done = []
    register(world, done)
    async with world.client(mode, Person(["x", "y", "z"])) as c:
        r = await c.call_tool("send", {"to": "ana"})
    assert r.is_error and "not approved after 3 tries" in text(r) and done == []


@pytest.mark.parametrize("mode", MODES)
@pytest.mark.parametrize("answer", ["decline", "cancel"])
async def test_decline_and_cancel_run_nothing(world, mode, answer):
    done = []
    register(world, done)
    async with world.client(mode, Person([answer])) as c:
        r = await c.call_tool("send", {"to": "ana"})
    assert r.is_error and "not approved" in text(r) and done == []


async def test_a_missing_answer_runs_nothing_and_the_same_state_twice_runs_once(world):
    done = []
    register(world, done)
    async with world.client("auto", Person()) as c:
        first = await c.session.call_tool("send", {"to": "ana"}, allow_input_required=True)
        assert isinstance(first, t.InputRequiredResult)
        missing = await c.session.call_tool("send", {"to": "ana"}, input_responses={},
                                            request_state=first.request_state, allow_input_required=True)
        assert missing.is_error and done == []
        again = await c.session.call_tool("send", {"to": "ana"}, allow_input_required=True)
        answer = {"yea": t.ElicitResult(action="accept", content={"confirm": "ana"})}
        ok = await c.session.call_tool("send", {"to": "ana"}, input_responses=answer,
                                       request_state=again.request_state, allow_input_required=True)
        replay = await c.session.call_tool("send", {"to": "ana"}, input_responses=answer,
                                           request_state=again.request_state, allow_input_required=True)
    assert not ok.is_error and replay.is_error and done == [("send", "ana")]


async def test_a_client_that_cant_ask_gets_consent_codes_and_a_signed_consent_runs_once(world):
    done = []
    register(world, done)
    async with world.client("auto") as c:
        r = await c.call_tool("send", {"to": "ana"})
        assert r.is_error and "yea approve" in text(r) and done == []
        (code,) = r.structured_content["codes"]
        consent = issue_grant(PRINCIPAL, world.approvals.service_id(), [
            {"svc": [world.approvals.service_id()]}, {"verbs": ["COMMIT"]}, {"can": ["send"]},
            {"only": code["planHash"]}, {"exp": 2**31}]).encode()
        await world.store.put_consent(code["planHash"], consent)
        assert not (await c.call_tool("send", {"to": "ana"})).is_error
        assert (await c.call_tool("send", {"to": "ana"})).is_error  # used once
    assert done == [("send", "ana")]


@pytest.mark.parametrize("mode", MODES)
async def test_preview_runs_and_stores_nothing_and_a_denied_tool_shows_nothing(world, mode, monkeypatch):
    done = []
    register(world, done)
    async with world.client(mode, Person()) as c:
        r = await c.call_tool("send", {"to": "ana", "preview": True})
        assert not r.is_error and text(r).startswith("preview: nothing was run") and done == []
        assert r.structured_content["plans"][0]["summary"] == "Send to ana"
        bad = await c.call_tool("send", {"to": "ana", "preview": "true"})
        assert bad.is_error and done == []
    world.approvals._y.tighten = {"deny": ["send"]}
    async with world.client(mode, Person()) as c:
        r = await c.call_tool("send", {"to": "ana", "preview": True})
    assert r.is_error and "never allows send" in text(r) and "Send to ana" not in text(r)


class Colour(str, Enum):
    red = "red"


class Item(BaseModel):
    sku_id: str = Field(alias="sku")
    qty: int


async def test_input_is_the_json_mode_dump(world):
    ap, srv = world.approvals, world.server

    @ap.job(srv, risk="low")
    async def order(item: Item, when: date, colour: Colour, amount: float = 1.0) -> list[Plan]:
        return [Plan("Order", [create("order/1")], apply=lambda: None)]

    async with world.client("auto") as c:
        r1 = await c.call_tool("order", {"item": {"sku": "a", "qty": 1}, "when": "2026-10-01", "colour": "red",
                                         "preview": True})
        r2 = await c.call_tool("order", {"item": {"sku": "a", "qty": 1}, "when": "2026-10-01", "colour": "red",
                                         "amount": 1, "preview": True})
        bad = await c.call_tool("order", {"item": {"sku": "a", "qty": 1}, "when": "2026-10-01", "colour": "red",
                                          "amount": 5.5, "preview": True})
    h1, h2 = (r.structured_content["plans"][0]["planHash"] for r in (r1, r2))
    assert h1 == h2 and not r1.is_error  # 1.0 and 1 hash the same
    assert bad.is_error and "use a string or an integer" in text(bad)
    # The order job has no revert, so it asks; approve it and read the receipt's input.
    async with world.client("auto", Person()) as c:
        r = await c.call_tool("order", {"item": {"sku": "a", "qty": 1}, "when": "2026-10-01", "colour": "red", "amount": 1})
    assert r.structured_content["receipt"]["input"] == {"item": {"sku": "a", "qty": 1}, "when": "2026-10-01",
                                                        "colour": "red", "amount": 1}


@pytest.mark.parametrize("mode", MODES)
async def test_a_result_that_cant_be_json_says_the_action_happened(world, mode):
    done = []

    @world.approvals.job(world.server, risk="low")
    async def odd(x: int) -> list[Plan]:
        loop = {}
        loop["self"] = loop
        return [Plan("Odd", [create("o/1")], apply=lambda: done.append(x) or loop)]

    async with world.client(mode, Person()) as c:
        r = await c.call_tool("odd", {"x": 1})
    assert done == [1] and not r.is_error
    assert "✓ Odd happened, but its receipt couldn't be saved" in text(r) and "nothing was run" not in text(r)


async def test_the_2025_in_call_ask_rejudges_against_fresh_plans(world):
    """Each 2025 round re-plans, as a 2026 retry would: plans that changed ask again."""
    done, rounds = [], []

    @world.approvals.job(world.server, risk="low")
    async def price(item: str) -> list[Plan]:
        rounds.append(1)
        cost = 10 if len(rounds) == 1 else 12  # the price moved while the person was reading
        return [Plan(f"Buy {item} for {cost}", [create("order/1")], apply=lambda: done.append(cost))]

    person = Person()
    async with world.client("legacy", person) as c:
        r = await c.call_tool("price", {"item": "pen"})
    assert not r.is_error and done == [12] and len(person.seen) == 2
    assert "the plans changed" in person.seen[1].message
