"""The README's quickstart in Python (examples/guard_quickstart.py) does what the README says:
``send_email`` shows the server's plan and asks for the recipient, a wrong phrase asks again, and
the right one sends. Three wrong phrases, or a client that can't show forms, send nothing. The
handler logs to stderr, since stdout is the MCP transport."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
from conftest import MODES, PRINCIPAL, Person, text
from yea_mcp import yea

from mcp import Client
from yea.store import FileStore

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "examples"))
import guard_quickstart  # noqa: E402

pytestmark = pytest.mark.anyio

EMAIL = {"to": "ana@example.com", "subject": "Q3 report"}
SENT = "email ana@example.com: Q3 report"


@pytest.fixture
def server(tmp_path):
    approvals = yea(name="mail", transport="stdio", home=tmp_path / "home", store=FileStore(tmp_path / "store"),
                    server_key=tmp_path / "k" / "mail.key", principal=PRINCIPAL.public,
                    policy=str(tmp_path / "policy.pg"))
    return guard_quickstart.create_server(approvals)


@pytest.mark.parametrize("mode", MODES)
async def test_it_asks_with_the_plan_asks_again_after_a_wrong_phrase_and_sends_once_the_recipient_is_typed(
        server, mode, capsys):
    person = Person(["approve", "ana@example.com"])
    async with Client(server, mode=mode, elicitation_callback=person) as c:
        r = await c.call_tool("send_email", EMAIL)
    out = capsys.readouterr()
    assert not r.is_error and text(r) == "sent to ana@example.com"
    assert len(person.seen) == 2
    message = person.seen[0].message
    assert "send_email can't be undone" in message and "[1] Email ana@example.com: Q3 report" in message
    assert "to approve, type: ana@example.com" in message
    assert out.err.count(SENT) == 1 and out.out == ""


@pytest.mark.parametrize("mode", MODES)
async def test_three_wrong_phrases_send_nothing(server, mode, capsys):
    person = Person(["approve", "approve", "approve"])
    async with Client(server, mode=mode, elicitation_callback=person) as c:
        r = await c.call_tool("send_email", EMAIL)
    assert "not approved after 3 tries" in text(r) and len(person.seen) == 3
    assert SENT not in capsys.readouterr().err


async def test_a_client_that_cant_show_forms_gets_nothing_sent(server, capsys):
    async with Client(server, mode="auto") as c:
        r = await c.call_tool("send_email", EMAIL)
    assert r.is_error and "yea approve" in text(r)
    assert SENT not in capsys.readouterr().err
