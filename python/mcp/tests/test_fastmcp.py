"""The FastMCP 4 adapter (SPEC-mcp-py, "FastMCP 4"): jobs, guard, undo, per era."""

from __future__ import annotations

import pytest
from fastmcp import Client, FastMCP
from fastmcp.tools.tool_transform import ArgTransform, TransformedTool
from yea import Plan, create, quantity

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


def sender(world, fm, done):
    @world.approvals.job(fm, risk="low", confirm_with=lambda hp, i: i["to"],
                         revert=lambda r, ctx: None)
    async def send(to: str) -> list[Plan]:
        return [Plan(f"Send to {to}", [create(f"mail/{to}")], apply=lambda: done.append(to),
                     undo_window=60, uses={"emails": quantity(1)})]


@pytest.mark.parametrize("mode", MODES)
async def test_policy_auto_run_settles_its_total(world, fm, mode):
    import os

    from yea import decode_grant
    from yea.store import LedgerKey

    done = []
    sender(world, fm, done)
    world.grant({"can": ["send"]}, {"total": {"of": "emails", "max": 5}})
    async with Client(fm, mode=mode) as c:
        r = await c.call_tool("send", {"to": "ana"})
    assert done == ["ana"] and "Send to ana" in text(r)
    assert await world.store.used(LedgerKey(decode_grant(os.environ["YEA_POLICY"]).id, "emails")) == 10**18


@pytest.mark.parametrize("mode", MODES)
@pytest.mark.parametrize("answers,expect", [(["x", "y", "z"], "not approved after 3 tries")])
async def test_three_wrong_phrases_refuse(world, fm, mode, answers, expect):
    done = []
    sender(world, fm, done)
    async with Client(fm, mode=mode, elicitation_handler=person(answers)) as c:
        r = await c.call_tool("send", {"to": "ana"}, raise_on_error=False)
    assert r.is_error and expect in text(r) and done == []


@pytest.mark.parametrize("mode", MODES)
async def test_decline_runs_nothing(world, fm, mode):
    from fastmcp.client.elicitation import ElicitResult

    done = []
    sender(world, fm, done)

    async def decline(message, response_type, params, ctx):
        return ElicitResult(action="decline")

    async with Client(fm, mode=mode, elicitation_handler=decline) as c:
        r = await c.call_tool("send", {"to": "ana"}, raise_on_error=False)
    assert r.is_error and "not approved" in text(r) and done == []


async def test_the_same_2026_state_twice_runs_once(world, fm):
    import mcp_types as t

    done = []
    sender(world, fm, done)
    async with Client(fm, elicitation_handler=person([])) as c:
        first = await c.session.call_tool("send", {"to": "ana"}, allow_input_required=True)
        answer = {"yea": t.ElicitResult(action="accept", content={"confirm": "ana"})}
        ok = await c.session.call_tool("send", {"to": "ana"}, input_responses=answer,
                                       request_state=first.request_state, allow_input_required=True)
        again = await c.session.call_tool("send", {"to": "ana"}, input_responses=answer,
                                          request_state=first.request_state, allow_input_required=True)
    assert not ok.is_error and again.is_error and done == ["ana"]


async def test_a_signed_consent_runs_once(world, fm):
    from yea import issue_grant

    from conftest import PRINCIPAL

    done = []
    sender(world, fm, done)
    async with Client(fm) as c:
        r = await c.call_tool("send", {"to": "ana"}, raise_on_error=False)
        (code,) = r.structured_content["codes"]
        sid = world.approvals.service_id()
        await world.store.put_consent(code["planHash"], issue_grant(PRINCIPAL, sid, [
            {"svc": [sid]}, {"verbs": ["COMMIT"]}, {"can": ["send"]}, {"only": code["planHash"]}, {"exp": 2**31}]).encode())
        assert not (await c.call_tool("send", {"to": "ana"})).is_error
        assert (await c.call_tool("send", {"to": "ana"}, raise_on_error=False)).is_error
    assert done == ["ana"]


async def test_previews_denied_and_non_boolean(world, fm):
    done = []
    sender(world, fm, done)
    async with Client(fm) as c:
        bad = await c.call_tool("send", {"to": "ana", "preview": "true"}, raise_on_error=False)
        assert bad.is_error and done == []
    world.approvals._y.tighten = {"deny": ["send"]}
    async with Client(fm) as c:
        r = await c.call_tool("send", {"to": "ana", "preview": True}, raise_on_error=False)
    assert r.is_error and "never allows send" in text(r) and "Send to ana" not in text(r)


async def test_guard_a_failing_original_and_one_with_its_own_preview(world, fm):
    import mcp_types as t

    calls = []

    @fm.tool
    def flaky(x: int):
        calls.append(x)
        return t.CallToolResult(content=[t.TextContent(type="text", text="down")], is_error=True)

    @fm.tool
    def publish(preview: bool = False) -> str:
        calls.append("publish")
        return "published"

    world.approvals.guard(fm, "flaky", describe=lambda a: {"summary": "Flaky", "effects": [], "risk": "low"})
    world.approvals.guard(fm, "publish", describe=lambda a: {"summary": "Publish", "effects": []})
    async with Client(fm, elicitation_handler=person([])) as c:
        f = await c.call_tool("flaky", {"x": 1}, raise_on_error=False)
        p = await c.call_tool("publish", {}, raise_on_error=False)
    assert f.is_error and text(f) == "down" and not (f.meta or {}).get("dev.yea/receipt") and calls == [1]
    assert p.is_error and "own preview argument" in text(p)
