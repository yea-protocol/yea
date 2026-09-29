"""The undo tool: within its window, then refused; another sub or server; a revert that fails part-way (SPEC-mcp-py)."""

from __future__ import annotations

import time

import pytest
import yea_mcp
from conftest import MODES, Person, text

from yea import Plan, create

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


async def test_a_revert_that_fails_part_way_says_so(world):
    """As TS: never "nothing was undone" when the revert may have half-happened (#149)."""
    def revert(r, ctx):
        raise yea_mcp.PartialApplyError("no answer; check the dashboard")

    @world.approvals.job(world.server, risk="low", revert=revert)
    async def move(event: str) -> list[Plan]:
        return [Plan(f"Move {event}", [create(f"event/{event}")], apply=lambda: {"moved": event}, undo_window=60)]

    world.grant({"can": ["move"]})
    async with world.client("auto", Person()) as c:
        rid = (await c.call_tool("move", {"event": "e1"})).structured_content["receipt"]["id"]
        r = await c.call_tool("undo", {"receipt": rid})
    assert r.is_error and text(r) == "✗ undo failed part-way: no answer; check the dashboard"
