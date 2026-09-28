"""The FastMCP 4 adapter (SPEC-mcp-py, "FastMCP 4"): jobs, guard, undo, per era."""

from __future__ import annotations

import pytest
from fastmcp import Client, FastMCP
from fastmcp.tools.tool_transform import ArgTransform, TransformedTool
from yea import Plan, create

from conftest import MODES, text

pytestmark = pytest.mark.anyio


@pytest.fixture
def fm(world):
    return FastMCP("billing", request_state_security=world.approvals.request_state_security())


def person(answers):
    queue = list(answers)

    async def answer(message, response_type, params, ctx):
        a = queue.pop(0) if queue else "approve"
        return {"confirm": a}

    return answer


@pytest.mark.parametrize("mode", MODES)
async def test_a_job_asks_and_runs_and_can_be_undone(world, fm, mode):
    done = []

    @world.approvals.job(fm, risk="low", confirm_with=lambda hp, i: i["to"],
                         revert=lambda r, ctx: done.append(("revert", r["input"])))
    async def send(to: str) -> list[Plan]:
        return [Plan(f"Send to {to}", [create(f"mail/{to}")], apply=lambda: done.append(("send", to)) or {"ok": 1},
                     undo_window=60)]

    async with Client(fm, mode=mode, elicitation_handler=person(["no", "ana"])) as c:
        pv = await c.call_tool("send", {"to": "ana", "preview": True})
        assert text(pv).startswith("preview: nothing was run") and done == []
        r = await c.call_tool("send", {"to": "ana"})
        assert done == [("send", "ana")]
        rid = r.structured_content["receipt"]["id"]
        u = await c.call_tool("undo", {"receipt": rid})
    assert text(u).startswith(f"↶ undid {rid}") and done[-1] == ("revert", {"to": "ana"})


async def test_a_client_that_cant_ask_gets_codes(world, fm):
    @world.approvals.job(fm, risk="low")
    async def send(to: str) -> list[Plan]:
        return [Plan(f"Send to {to}", [create("mail/x")], apply=lambda: None)]

    async with Client(fm) as c:
        r = await c.call_tool("send", {"to": "ana"}, raise_on_error=False)
    assert r.is_error and "yea approve" in text(r)


@pytest.mark.parametrize("mode", MODES)
async def test_guard_wraps_an_existing_tool(world, fm, mode):
    calls = []

    @fm.tool
    def wipe(target: str) -> str:
        calls.append(target)
        return f"wiped {target}"

    world.approvals.guard(fm, "wipe", describe=lambda a: {"summary": f"Wipe {a['target']}", "effects": [], "risk": "low"},
                          confirm_with=lambda hp, i: i["target"])
    async with Client(fm, mode=mode, elicitation_handler=person(["db"])) as c:
        listed = {tl.name: tl for tl in await c.list_tools()}
        assert "preview" in listed["wipe"].input_schema["properties"]
        pv = await c.call_tool("wipe", {"target": "db", "preview": True}, raise_on_error=False)
        assert pv.is_error and calls == []  # an output-schema tool's own results are errors
        r = await c.call_tool("wipe", {"target": "db"})
    assert calls == ["db"] and text(r) == "wiped db" and r.meta["dev.yea/receipt"]["tool"] == "wipe"


async def test_a_transform_over_a_guarded_tool_is_refused(world, fm):
    calls = []

    @fm.tool
    def wipe(target: str) -> str:
        calls.append(target)
        return "wiped"

    world.approvals.guard(fm, "wipe", describe=lambda a: {"summary": "Wipe", "effects": [], "risk": "low"})
    original = await fm.get_tool("wipe")
    fm.add_tool(TransformedTool.from_tool(original, name="wipe2", transform_args={"target": ArgTransform(name="t")}))
    async with Client(fm) as c:
        r = await c.call_tool("wipe2", {"t": "db"}, raise_on_error=False)
    assert r.is_error and "transform of a guarded tool" in text(r) and calls == []


async def test_a_task_enabled_tool_is_refused_by_guard(world, fm):
    """Running task tools needs FastMCP's tasks extension, so this drives the middleware directly."""
    from fastmcp.tools import Tool

    from yea_mcp.fastmcp import FastMCPGuard
    from yea_mcp.guard import Guarded

    async def slow(x: int) -> str:
        return "ok"

    tool = Tool.from_function(slow, task=True)
    guard = FastMCPGuard(world.approvals._y, fm)
    g = Guarded(lambda a: {"summary": "Slow", "effects": []}, None, None)
    guard.tools["slow"] = g
    r = await guard._call(context=None, call_next=None, tool=tool, g=g)
    assert r.is_error and "background task" in text(r)
