"""Closed options (SPEC-mcp-py, "Closed options"). The keyword arguments are closed by their
signatures; what's checked here is the dicts inside them (``tighten``, ``annotations``) and the
enum values (``risk``): an unknown key or a value of the wrong type raises ``TypeError``, a value
outside its set ``ValueError``, before anything is registered or written. The refusals that close
a security hole are in test_security.py."""

from __future__ import annotations

import mcp_types as t
import pytest
from conftest import PRINCIPAL
from mcp.server.mcpserver import MCPServer
from yea_mcp import yea

from yea import Plan

pytestmark = pytest.mark.anyio


def start(tmp_path, **options):
    return yea(name="billing", transport="stdio", home=tmp_path / "home", server_key=tmp_path / "k.key",
               principal=PRINCIPAL.public, **options)


def on_server(tmp_path):
    a = start(tmp_path)
    return a, MCPServer("billing", request_state_security=a.request_state_security())


def plan(charge: str) -> list[Plan]:
    return []


async def listed(server):
    return {tl.name: tl for tl in await server.list_tools()}


def test_tighten_names_an_unknown_key_by_its_path_and_the_known_ones(tmp_path):
    with pytest.raises(TypeError) as e:
        start(tmp_path, tighten={"out_of_band": "medium"})
    assert str(e.value) == ('yea(): unknown option "tighten.out_of_band"; known: tighten.deny, '
                            'tighten.outOfBand')
    assert not (tmp_path / "k.key").exists()  # refused before the key file is created


def test_tighten_takes_its_documented_keys(tmp_path):
    start(tmp_path, tighten={"deny": ["refund"], "outOfBand": "medium"})
    start(tmp_path, tighten={})


async def test_job_refuses_unknown_or_wrongly_typed_annotations_and_registers_nothing(tmp_path):
    a, server = on_server(tmp_path)
    with pytest.raises(TypeError) as e:
        a.job(server, annotations={"read_only_hint": True})
    assert str(e.value) == ('job(): unknown option "annotations.read_only_hint"; known: annotations.title, '
                            'annotations.readOnlyHint, annotations.destructiveHint, annotations.idempotentHint, '
                            'annotations.openWorldHint')
    with pytest.raises(TypeError, match=r"^job\(\): annotations.destructiveHint must be True or False$"):
        a.job(server, annotations={"destructiveHint": "no"})
    with pytest.raises(TypeError, match=r"^job\(\): annotations.title must be a string$"):
        a.job(server, annotations={"title": 1})
    with pytest.raises(TypeError, match=r"^job\(\): annotations must be a dict or a ToolAnnotations$"):
        a.job(server, annotations=["readOnlyHint"])
    assert await listed(server) == {}


async def test_job_takes_annotations_as_a_dict_or_a_tool_annotations(tmp_path):
    a, server = on_server(tmp_path)
    a.job(server, name="one", annotations={"title": "One", "openWorldHint": False})(plan)
    a.job(server, name="two", annotations=t.ToolAnnotations(open_world_hint=False))(plan)
    tools = await listed(server)
    assert tools["one"].annotations.title == "One"
    assert tools["two"].annotations.open_world_hint is False


async def test_job_and_guard_refuse_an_unlisted_risk(tmp_path):
    a, server = on_server(tmp_path)
    server.add_tool(lambda amount: amount, name="charge")
    middleware = list(server.middleware)
    with pytest.raises(ValueError, match=r"^job\(\): risk must be 'low', 'medium' or 'high'$"):
        a.job(server, risk="hgh")
    with pytest.raises(ValueError, match=r"^guard\(\): risk must be 'low', 'medium' or 'high'$"):
        a.guard(server, "charge", describe=lambda i: {"summary": "Charge", "effects": []}, risk="hgh")
    assert list(await listed(server)) == ["charge"]
    assert server.middleware == middleware  # no guard installed
