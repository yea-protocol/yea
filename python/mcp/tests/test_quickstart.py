"""The Python guide's example (examples/mcp_quickstart.py, site/guide/mcp-python.md) does what
the guide says, step by step: the guarded tool asks, the job undoes, a policy lets only the
undoable job run on its own, and a client that can't ask gets consent codes."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
from mcp import Client
from yea import issue_grant
from yea.store import FileStore

from conftest import MODES, PRINCIPAL, Person, text
from yea_mcp import yea

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "examples"))
import mcp_quickstart  # noqa: E402

pytestmark = pytest.mark.anyio


@pytest.fixture
def files(tmp_path, monkeypatch):
    monkeypatch.setenv("YEA_HOME", str(tmp_path / "home"))
    monkeypatch.delenv("YEA_POLICY", raising=False)
    root = tmp_path / "files"
    (root / "docs").mkdir(parents=True)
    report = root / "docs" / "report.pdf"
    report.write_text("q3")
    store = FileStore(tmp_path / "store")
    approvals = yea(name="files", transport="stdio", store=store, server_key=tmp_path / "k" / "files.key",
                    principal=PRINCIPAL.public)
    return {"approvals": approvals, "store": store, "root": root, "report": report,
            "server": mcp_quickstart.create_server(approvals, str(root))}


@pytest.mark.parametrize("mode", MODES)
async def test_step_2_the_guarded_tool_asks_and_runs_once_the_name_is_typed(files, mode):
    person = Person(["approve", "report.pdf"])
    async with Client(files["server"], mode=mode, elicitation_callback=person) as c:
        r = await c.call_tool("delete_file", {"path": "docs/report.pdf"})
    assert not r.is_error and text(r) == "deleted docs/report.pdf" and not files["report"].exists()
    message = person.seen[0].message
    assert "Approval needed: delete_file can't be undone." in message and "[1] Delete docs/report.pdf" in message
    assert "to approve, type: report.pdf" in message


async def test_step_2_a_path_outside_the_folder_is_refused_before_asking(files):
    person = Person()
    async with Client(files["server"], mode="auto", elicitation_callback=person) as c:
        r = await c.call_tool("delete_file", {"path": "../outside"})
    assert r.is_error and person.seen == []


@pytest.mark.parametrize("mode", MODES)
async def test_step_4_the_job_asks_and_undo_puts_the_file_back(files, mode):
    async with Client(files["server"], mode=mode, elicitation_callback=Person()) as c:
        pv = await c.call_tool("move_to_trash", {"path": "docs/report.pdf", "preview": True})
        assert files["report"].exists() and "preview: nothing was run" in text(pv)
        r = await c.call_tool("move_to_trash", {"path": "docs/report.pdf"})
        assert not r.is_error and not files["report"].exists()
        rid = r.structured_content["receipt"]["id"]
        u = await c.call_tool("undo", {"receipt": rid})
    assert not u.is_error and files["report"].read_text() == "q3"


async def test_step_5_a_policy_lets_only_the_undoable_job_run_on_its_own(files, monkeypatch):
    grant = issue_grant(PRINCIPAL, files["approvals"].service_id(), [{"can": ["move_to_trash"]}, {"risk": "low"}])
    monkeypatch.setenv("YEA_POLICY", grant.encode())
    person = Person(["decline"])
    async with Client(files["server"], mode="auto", elicitation_callback=person) as c:
        moved = await c.call_tool("move_to_trash", {"path": "docs/report.pdf"})
        assert not moved.is_error and not files["report"].exists() and person.seen == []  # no question
        (files["root"] / "docs" / "other.txt").write_text("x")
        asked = await c.call_tool("delete_file", {"path": "docs/other.txt"})
    assert asked.is_error and len(person.seen) == 1  # the guard still asks


async def test_step_6_a_client_that_cant_ask_gets_a_code_and_a_consent_runs_once(files):
    async with Client(files["server"], mode="auto") as c:
        r = await c.call_tool("delete_file", {"path": "docs/report.pdf"})
        assert r.is_error and "yea approve" in text(r) and files["report"].exists()
        (code,) = r.structured_content["codes"]
        sid = files["approvals"].service_id()
        await files["store"].put_consent(code["planHash"], issue_grant(PRINCIPAL, sid, [
            {"svc": [sid]}, {"verbs": ["COMMIT"]}, {"can": ["delete_file"]}, {"only": code["planHash"]},
            {"exp": 2**31}]).encode())
        ok = await c.call_tool("delete_file", {"path": "docs/report.pdf"})
    assert not ok.is_error and not files["report"].exists()


def test_the_start_up_lines(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("YEA_HOME", str(tmp_path))
    monkeypatch.delenv("YEA_PRINCIPAL_PUB", raising=False)
    import yea_mcp.keys

    monkeypatch.setattr(yea_mcp.keys, "_warned", set())  # the warning is printed once per process
    ap = yea(name="files", transport="stdio", server_key=tmp_path / "k" / "files.key")
    err = capsys.readouterr().err
    assert f"yea: service id {ap.service_id()} (name files)" in err
    assert ("yea: no pinned principal key (YEA_PRINCIPAL_PUB is not set): nothing auto-runs and no consent is "
            "accepted") in err
