"""``require_interaction`` (SPEC-mcp-py): Claude Code's prompt-on-every-call key goes on every tool
that acts (a job, a guarded tool, ``undo``) and on no read, only when it's turned on. Both server
kinds, the MCP SDK's and FastMCP's."""

from __future__ import annotations

import pytest
from conftest import PRINCIPAL
from fastmcp import Client, FastMCP
from mcp import Client as SdkClient
from mcp.server.mcpserver import MCPServer
from yea_mcp import yea

pytestmark = pytest.mark.anyio

KEY = "anthropic/requiresUserInteraction"


def approvals(tmp_path, **options):
    return yea(name="billing", transport="stdio", home=tmp_path / "home", store=None,
               server_key=tmp_path / "server.key", principal=PRINCIPAL.public, **options)


def serve(a, server, job_options, guard_options=None):
    """A job with revert (so ``undo``), a guarded tool and a read, on ``server``."""
    @server.tool(meta={"example.com/own": 1})
    def charge(amount: str) -> str:
        return amount

    @server.tool(annotations={"readOnlyHint": True})
    def balance() -> str:
        return "0"

    a.job(server, name="refund", revert=lambda r, ctx: None, **job_options)(lambda charge: [])
    a.guard(server, "charge", describe=lambda i: {"summary": "Charge", "effects": []}, **(guard_options or {}))


def new_server(a, kind):
    return (FastMCP if kind == "fastmcp" else MCPServer)("billing", request_state_security=a.request_state_security())


async def tools_of(server, kind):
    """Every tool ``server`` lists, by name, with its ``_meta``."""
    if kind == "fastmcp":
        async with Client(server) as c:
            return {tl.name: tl.meta or {} for tl in await c.list_tools()}
    async with SdkClient(server, mode="auto") as c:
        return {tl.name: tl.meta or {} for tl in (await c.list_tools()).tools}


async def listed(tmp_path, kind, options=None, job_options=None, guard_options=None):
    """Every tool the server lists, by name, with its ``_meta``."""
    a = approvals(tmp_path, **(options or {}))
    server = new_server(a, kind)
    serve(a, server, job_options or {}, guard_options)
    return await tools_of(server, kind)


def prompted(tools):
    return sorted(name for name, meta in tools.items() if meta.get(KEY) is True)


KINDS = ["sdk", "fastmcp"]


@pytest.mark.parametrize("kind", KINDS)
async def test_off_by_default_no_tool_carries_the_key(tmp_path, kind):
    assert prompted(await listed(tmp_path, kind)) == []


@pytest.mark.parametrize("kind", KINDS)
async def test_on_it_marks_every_tool_that_acts_and_no_read(tmp_path, kind):
    tools = await listed(tmp_path, kind, {"require_interaction": True})
    assert sorted(tools) == ["balance", "charge", "refund", "undo"]
    assert prompted(tools) == ["charge", "refund", "undo"]
    assert tools["charge"]["example.com/own"] == 1  # a guarded tool keeps its own _meta


@pytest.mark.parametrize("kind", KINDS)
async def test_a_jobs_own_setting_wins_for_that_job_and_undo_is_on_if_any_is(tmp_path, kind):
    assert prompted(await listed(tmp_path, kind, job_options={"require_interaction": True})) == ["refund", "undo"]
    on, job_off = {"require_interaction": True}, {"require_interaction": False}
    assert prompted(await listed(tmp_path, kind, on, job_off)) == ["charge", "undo"]


@pytest.mark.parametrize("kind", KINDS)
async def test_a_guards_own_setting_wins_for_that_tool_and_one_on_marks_undo_too(tmp_path, kind):
    on, off = {"require_interaction": True}, {"require_interaction": False}
    assert prompted(await listed(tmp_path, kind, guard_options=on)) == ["charge", "undo"]
    assert prompted(await listed(tmp_path, kind, on, guard_options=off)) == ["refund", "undo"]


@pytest.mark.parametrize("kind", KINDS)
async def test_undo_gains_the_key_when_a_job_with_it_on_comes_after_undo(tmp_path, kind):
    a = approvals(tmp_path)
    server = new_server(a, kind)
    # undo is registered here, off; a later job without revert turns it on.
    a.job(server, name="refund", revert=lambda r, ctx: None)(lambda charge: [])
    a.job(server, name="resend", require_interaction=True)(lambda charge: [])
    tools = await tools_of(server, kind)
    assert prompted(tools) == ["resend", "undo"]
