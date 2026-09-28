"""guard(): an existing tool becomes a job without touching its code (SPEC-mcp-py, Testing)."""

from __future__ import annotations

import mcp_types as t
import pytest
from mcp.server.mcpserver import MCPServer

from conftest import MODES, Person, text

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
    calls = []
    existing(world, calls)
    world.grant({"can": ["flaky"]})
    async with world.client(mode, Person()) as c:
        r = await c.call_tool("flaky", {"x": 1})
    assert r.is_error and text(r) == "upstream down" and calls == [("flaky", 1)]
    assert not (r.meta or {}).get("dev.yea/receipt")


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
