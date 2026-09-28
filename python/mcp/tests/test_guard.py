"""guard(): an existing tool becomes a job without touching its code (SPEC-mcp-py, Testing)."""

from __future__ import annotations

import mcp_types as t
import pytest
from conftest import MODES, Person, text
from mcp.server.mcpserver import MCPServer
from yea import Plan, create

pytestmark = pytest.mark.anyio


def existing(world, calls):
    @world.server.tool()
    async def delete_branch(branch: str) -> str:
        """Delete a branch."""
        calls.append(branch)
        return f"deleted {branch}"

    @world.server.tool()
    async def flaky(x: int):
        calls.append(("flaky", x))
        return t.CallToolResult(content=[t.TextContent(type="text", text="upstream down")], is_error=True)

    def describe(args):
        return {"summary": f"Delete {args.get('branch')}", "effects": [{"op": "delete", "target": f"branch/{args.get('branch')}"}],
                "risk": "low"}

    world.approvals.guard(world.server, "delete_branch", describe=describe,
                          confirm_with=lambda hp, i: str(i.get("branch")))
    world.approvals.guard(world.server, "flaky", describe=lambda a: {"summary": "Flaky", "effects": [], "risk": "low"})


@pytest.mark.parametrize("mode", MODES)
async def test_the_original_runs_only_once_approved_and_passes_through(world, mode):
    calls = []
    existing(world, calls)
    async with world.client(mode, Person(["nope", "old-nav"])) as c:
        r = await c.call_tool("delete_branch", {"branch": "old-nav"})
    assert calls == ["old-nav"] and not r.is_error
    assert text(r) == "deleted old-nav" and r.structured_content == {"result": "deleted old-nav"}
    receipt = r.meta["dev.yea/receipt"]
    assert receipt["tool"] == "delete_branch" and receipt["input"] == {"branch": "old-nav"}


@pytest.mark.parametrize("mode", MODES)
async def test_an_output_schema_tools_own_results_are_errors_and_preview_never_reaches_it(world, mode):
    calls = []
    existing(world, calls)
    async with world.client(mode, Person(["decline"])) as c:
        pv = await c.call_tool("delete_branch", {"branch": "old-nav", "preview": True})
        no = await c.call_tool("delete_branch", {"branch": "old-nav"})
        bad = await c.call_tool("delete_branch", {"branch": "old-nav", "preview": 1})
    assert pv.is_error and text(pv).startswith("preview: nothing was run")
    assert no.is_error and "not approved" in text(no)
    assert bad.is_error and calls == []
    async with world.client(mode) as c:  # can't ask: consent codes, also an error
        codes = await c.call_tool("delete_branch", {"branch": "old-nav"})
    assert codes.is_error and "yea approve" in text(codes) and calls == []


async def test_the_listing_advertises_preview_and_the_job_annotations(world):
    existing(world, [])
    async with world.client("auto") as c:
        tools = {tl.name: tl for tl in (await c.list_tools()).tools}
    d = tools["delete_branch"]
    assert d.input_schema["properties"]["preview"]["type"] == "boolean"
    assert d.annotations.destructive_hint is True and d.meta["dev.yea/job"]["undoable"] is False


@pytest.mark.parametrize("mode", MODES)
async def test_a_failing_original_writes_no_receipt_and_releases(world, mode):
    import os

    from yea import decode_grant
    from yea.store import LedgerKey

    calls = []

    @world.server.tool()
    async def charge(cents: int):
        calls.append(cents)
        return t.CallToolResult(content=[t.TextContent(type="text", text="card declined")], is_error=True)

    world.approvals.guard(world.server, "charge", revert=lambda r, ctx: None,
                          describe=lambda a: {"summary": "Charge", "effects": [], "risk": "low", "undo_window": 60,
                                              "uses": {"spend": {"amount": a["cents"], "scale": 2, "unit": "USD"}}})
    world.grant({"can": ["charge"]}, {"total": {"of": "spend", "max": 10000, "scale": 2, "unit": "USD"}})
    async with world.client(mode, Person()) as c:
        r = await c.call_tool("charge", {"cents": 500})
    assert r.is_error and text(r) == "card declined" and calls == [500]  # auto-run, with a reservation
    assert not (r.meta or {}).get("dev.yea/receipt")
    block = decode_grant(os.environ["YEA_POLICY"]).id
    assert await world.store.used(LedgerKey(block, "spend")) == 0  # released


async def test_guarding_a_tool_twice_is_refused(world):
    existing(world, [])
    with pytest.raises(ValueError, match="already guarded"):
        world.approvals.guard(world.server, "delete_branch", describe=lambda a: {"summary": "x", "effects": []})


async def test_a_tool_with_its_own_preview_is_refused(world):
    calls = []

    @world.server.tool()
    async def publish(preview: bool = False) -> str:
        calls.append(preview)
        return "published"

    world.approvals.guard(world.server, "publish", describe=lambda a: {"summary": "Publish", "effects": []})
    async with world.client("auto", Person()) as c:
        r = await c.call_tool("publish", {})
    assert r.is_error and "own preview argument" in text(r) and calls == []


async def test_guarding_one_server_doesnt_guard_another(world):
    calls = []
    existing(world, calls)
    other = MCPServer("other", request_state_security=world.approvals.request_state_security())

    @other.tool()
    async def delete_branch(branch: str) -> str:
        calls.append(("other", branch))
        return "deleted"

    from mcp import Client

    async with Client(other, mode="auto") as c:
        r = await c.call_tool("delete_branch", {"branch": "x"})
    assert not r.is_error and calls == [("other", "x")]


async def test_guarding_a_job_tool_is_refused(world):
    """A job() tool is already guarded: a second routine around it would ask twice (#151, as mcp-ts)."""
    done = []

    @world.approvals.job(world.server, risk="low")
    async def move(event: str) -> list[Plan]:
        return [Plan(f"Move {event}", [create("e")], apply=lambda: done.append(event))]

    world.approvals.guard(world.server, "move", describe=lambda a: {"summary": "Move", "effects": []})
    async with world.client("auto", Person()) as c:
        r = await c.call_tool("move", {"event": "e1"})
    assert r.is_error and "guard(): move is already a job tool; nothing was run" in text(r) and done == []


async def test_guard_risk_is_the_default_plan_risk_and_what_the_listing_shows(world):
    @world.server.tool()
    async def wipe(target: str) -> str:
        return "wiped"

    world.approvals.guard(world.server, "wipe", risk="high", describe=lambda a: {"summary": "Wipe", "effects": []})
    async with world.client("auto") as c:
        listed = {tool.name: tool for tool in (await c.list_tools()).tools}
        pv = await c.call_tool("wipe", {"target": "x", "preview": True})
    assert listed["wipe"].meta["dev.yea/job"]["risk"] == "high"
    assert pv.structured_content["plans"][0]["risk"] == "high"


async def test_a_tool_re_registered_after_a_listing_is_read_again(world):
    """The listing is re-read after each tools/list, so a re-registered tool isn't judged by stale info."""
    @world.server.tool()
    async def publish(target: str) -> str:
        return "published"

    world.approvals.guard(world.server, "publish", describe=lambda a: {"summary": "Publish", "effects": []})
    async with world.client("auto", Person(["decline"])) as c:
        first = await c.call_tool("publish", {"target": "x"})  # learns the listing
        world.server._tool_manager.remove_tool("publish")

        @world.server.tool()
        async def publish(target: str, preview: bool = False) -> str:  # noqa: F811 — now with its own preview
            return "published"

        await c.list_tools()
        second = await c.call_tool("publish", {"target": "x"})
    assert first.is_error and "not approved" in text(first)
    assert second.is_error and "own preview argument" in text(second)


def test_a_revert_needs_the_undo_name_free(world):
    """As mcp-ts: a job or guard with revert refuses a server whose undo tool isn't YEA's (#151)."""
    @world.server.tool()
    async def undo(receipt: str) -> str:
        return "the server's own undo"

    with pytest.raises(ValueError, match="already has a tool named undo"):
        @world.approvals.job(world.server, revert=lambda r, ctx: None)
        async def move(event: str) -> list[Plan]:
            return []
    with pytest.raises(ValueError, match="already has a tool named undo"):
        world.approvals.guard(world.server, "undo", describe=lambda a: {"summary": "x", "effects": []},
                              revert=lambda r, ctx: None)


def test_a_second_job_with_revert_reuses_yeas_own_undo(world):
    for name in ("a", "b"):
        world.approvals.job(world.server, name=name, revert=lambda r, ctx: None)(lambda event: [])
    assert world.server._tool_manager.get_tool("undo") is not None
