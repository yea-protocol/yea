"""The approval core's security list, from the MCP side (SPEC-mcp-py, Testing)."""

from __future__ import annotations

import json

import httpx2
import mcp_types as t
import pytest
from mcp import Client
from mcp.client.streamable_http import streamable_http_client
from mcp.server.mcpserver import MCPServer
from yea import Plan, create, issue_grant
from yea.store import FileStore

from conftest import PRINCIPAL, Person, text
from yea_mcp import yea

pytestmark = pytest.mark.anyio


def consent_for(world, tool, plan_hash):
    sid = world.approvals.service_id()
    return issue_grant(PRINCIPAL, sid, [{"svc": [sid]}, {"verbs": ["COMMIT"]}, {"can": [tool]}, {"only": plan_hash},
                                        {"exp": 2**31}]).encode()


def jobs(world, done):
    ap, srv = world.approvals, world.server

    @ap.job(srv, risk="low")
    async def refund(amount: int) -> list[Plan]:
        return [Plan(f"Refund {amount}", [create("refund")], apply=lambda: done.append(("refund", amount))),
                Plan(f"Force refund {amount}", [create("refund")], risk="high", apply=lambda: done.append(("force", amount)))]

    @ap.job(srv, risk="low")
    async def move(event: str) -> list[Plan]:
        return [Plan(f"Move {event}", [create("e")], apply=lambda: done.append(("move", event)))]  # no undo window


async def plan_hashes(world, tool, args):
    async with world.client("auto") as c:
        r = await c.call_tool(tool, {**args, "preview": True})
    return [p["planHash"] for p in r.structured_content["plans"]]


async def test_a_denied_tool_never_runs_even_with_a_stored_consent(world):
    done = []
    jobs(world, done)
    (h, _) = await plan_hashes(world, "refund", {"amount": 5})
    await world.store.put_consent(h, consent_for(world, "refund", h))
    world.approvals._y.tighten = {"deny": ["refund"]}
    async with world.client("auto", Person()) as c:
        r = await c.call_tool("refund", {"amount": 5})
    assert r.is_error and done == []


async def test_a_high_plan_is_never_offered_in_the_form_and_cant_be_chosen(world):
    done = []
    jobs(world, done)
    (_, high) = await plan_hashes(world, "refund", {"amount": 5})
    person = Person([{"plan": high, "confirm": "approve"}])
    async with world.client("auto", person) as c:
        r = await c.call_tool("refund", {"amount": 5})
    schema = person.seen[0].requested_schema
    assert "plan" not in schema["properties"]  # only the low plan is offered
    assert "Not offered here" in person.seen[0].message
    assert r.is_error and ("force", 5) not in done


async def test_an_irreversible_plan_never_auto_runs(world):
    done = []
    jobs(world, done)
    world.grant({"can": ["*"]}, {"risk": "high"})
    async with world.client("auto") as c:
        r = await c.call_tool("move", {"event": "e1"})
    assert r.is_error and "can't be undone" in text(r) and done == []


async def test_a_consent_for_one_plan_never_runs_another(world):
    done = []
    jobs(world, done)
    (h5, _) = await plan_hashes(world, "refund", {"amount": 5})
    (h6, _) = await plan_hashes(world, "refund", {"amount": 6})
    await world.store.put_consent(h6, consent_for(world, "refund", h5))
    async with world.client("auto") as c:
        r = await c.call_tool("refund", {"amount": 6})
    assert r.is_error and done == []


async def test_a_stored_copy_of_the_policy_grant_never_counts_as_a_consent(world):
    done = []
    jobs(world, done)
    (h, _) = await plan_hashes(world, "refund", {"amount": 5})
    await world.store.put_consent(h, issue_grant(PRINCIPAL, world.approvals.service_id(), [{"can": ["*"]}]).encode())
    async with world.client("auto") as c:
        r = await c.call_tool("refund", {"amount": 5})
    assert r.is_error and done == []


async def test_a_verified_state_without_yea_is_refused(world, monkeypatch):
    """A state the SDK sealed for this very tool and input, but that isn't our approval."""
    done = []
    jobs(world, done)
    import yea_mcp.call.route as call_mod  # where _ask reads input_required

    real = call_mod.input_required
    monkeypatch.setattr(call_mod, "input_required", lambda form, state: t.InputRequiredResult(
        input_requests=real(form, state).input_requests, request_state=json.dumps({"other": state})))
    async with world.client("auto", Person()) as c:
        first = await c.session.call_tool("refund", {"amount": 5}, allow_input_required=True)
        assert isinstance(first, t.InputRequiredResult)
        answer = {"yea": t.ElicitResult(action="accept", content={"confirm": "approve"})}
        r = await c.session.call_tool("refund", {"amount": 5}, input_responses=answer,
                                      request_state=first.request_state, allow_input_required=True)
    assert r.is_error and "belongs to something else" in text(r) and done == []


async def test_another_jobs_state_is_refused(world):
    done = []
    jobs(world, done)

    @world.approvals.job(world.server, risk="low")
    async def refund_other(amount: int) -> list[Plan]:
        return [Plan("Other", [create("x")], apply=lambda: done.append("other"))]

    from mcp.shared.exceptions import MCPError
    from yea.approval import check_state

    async with world.client("auto", Person()) as c:
        first = await c.session.call_tool("refund", {"amount": 5}, allow_input_required=True)
        answer = {"yea": t.ElicitResult(action="accept", content={"confirm": "approve"})}
        with pytest.raises(MCPError):  # the SDK's binding: the state was sealed for another tool
            await c.session.call_tool("refund_other", {"amount": 5}, input_responses=answer,
                                      request_state=first.request_state, allow_input_required=True)
    assert done == [] and not first.request_state.startswith("{")  # sealed on the wire, never our plaintext
    # And our own check, should a state ever get past the binding: it names its tool.
    from yea.approval import input_hash, new_state

    ours = new_state("refund", input_hash({"amount": 5}), "", ["h"], 1, 1_790_000_000)
    assert check_state(ours, "refund_other", input_hash({"amount": 5}), "", 1_790_000_000) is None


async def test_a_state_replayed_by_another_caller_is_refused(tmp_path, monkeypatch):
    import contextvars

    monkeypatch.setenv("YEA_HOME", str(tmp_path))
    who = contextvars.ContextVar("who", default="alice")
    done = []
    ap = yea(name="s", transport="http", sub=lambda r: who.get(), store=FileStore(tmp_path / "st"),
             server_key=tmp_path / "k", principal=PRINCIPAL.public)
    srv = MCPServer("s", request_state_security=ap.request_state_security())

    @ap.job(srv, risk="low")
    async def send(to: str) -> list[Plan]:
        return [Plan(f"Send to {to}", [create("mail/x")], apply=lambda: done.append(to))]

    async with Client(srv, mode="auto", elicitation_callback=Person()) as c:
        first = await c.session.call_tool("send", {"to": "ana"}, allow_input_required=True)
        who.set("bob")
        answer = {"yea": t.ElicitResult(action="accept", content={"confirm": "approve"})}
        r = await c.session.call_tool("send", {"to": "ana"}, input_responses=answer,
                                      request_state=first.request_state, allow_input_required=True)
    assert r.is_error and "invalid, expired, already used, or for another call" in text(r) and done == []


async def test_a_client_that_claims_elicitation_but_cant_answer_gets_codes(world):
    done = []
    jobs(world, done)

    async def broken(ctx, params):
        raise RuntimeError("no UI here")

    async with world.client("legacy", broken) as c:
        r = await c.call_tool("refund", {"amount": 5})
    assert r.is_error and "yea approve" in text(r) and done == []


async def test_guarding_a_tool_the_server_doesnt_define_fails_loudly(world):
    """An app's tool (reachable by a hashed name too) isn't this server's own: guard it where it's
    defined. Guarding it here stops the server rather than leave it reachable unguarded."""
    from fastmcp import Client as FastClient
    from fastmcp import FastMCP
    from fastmcp.apps.app import FastMCPApp
    from fastmcp.server.providers.addressing import hash_tool

    fm = FastMCP("b", request_state_security=world.approvals.request_state_security())
    app = FastMCPApp("dash")
    calls = []

    @app.tool(model=True)
    def wipe(target: str) -> str:
        calls.append(target)
        return "wiped " + target

    fm.add_provider(app)
    world.approvals.guard(fm, "wipe", describe=lambda a: {"summary": "Wipe", "effects": [], "risk": "low"})
    async with FastClient(fm) as c:
        for name in ("wipe", hash_tool("dash", "wipe") + "_wipe"):
            r = await c.call_tool(name, {"target": "db"}, raise_on_error=False)
            assert r.is_error and "isn't one of this server's own tools" in text(r)
    assert calls == []


async def test_renamed_copies_of_a_guarded_fastmcp_tool_still_need_approval(world):
    from fastmcp import Client as FastClient
    from fastmcp import FastMCP
    from fastmcp.server.transforms import Namespace

    child = FastMCP("child")
    parent = FastMCP("b", request_state_security=world.approvals.request_state_security())
    calls = []

    @child.tool
    def wipe(target: str) -> str:
        calls.append(target)
        return "wiped"

    world.approvals.guard(child, "wipe", describe=lambda a: {"summary": "Wipe", "effects": [], "risk": "low"})
    parent.mount(child, namespace="c")
    parent.add_transform(Namespace("x"))
    async with FastClient(parent) as c:
        r = await c.call_tool("x_c_wipe", {"target": "db"}, raise_on_error=False)
    assert r.is_error and "yea approve" in text(r) and calls == []


async def test_a_failing_original_with_a_broken_store_is_still_its_own_error(world):
    import mcp_types as mt

    calls = []

    @world.server.tool()
    async def charge(cents: int) -> str:
        calls.append(cents)
        raise RuntimeError("card declined")

    world.approvals.guard(world.server, "charge", revert=lambda r, ctx: None,
                          describe=lambda a: {"summary": "Charge", "effects": [], "risk": "low", "undo_window": 60,
                                              "uses": {"spend": {"amount": a["cents"], "scale": 2, "unit": "USD"}}})
    world.grant({"can": ["charge"]}, {"total": {"of": "spend", "max": 10000, "scale": 2, "unit": "USD"}})

    async def broken(r):
        raise OSError("disk full")

    world.store.release = broken
    async with world.client("auto", Person()) as c:
        r = await c.call_tool("charge", {"cents": 500})
    assert r.is_error and "happened" not in text(r) and calls == [500]
    assert isinstance(r, mt.CallToolResult)


def write_policy_file(world, content):
    from pathlib import Path

    home = Path(world.home)
    home.mkdir(parents=True, exist_ok=True)
    if content is None:
        (home / "policy.json").mkdir()  # unreadable as a file
    else:
        (home / "policy.json").write_text(content)


@pytest.mark.parametrize("content", ["{not json", '{"deny": "refund"}', '{"outOfBand": "never"}', "[1, 2]", "null",
                                     '{"deny": ["a"], "x": NaN}', None])
async def test_a_broken_policy_file_refuses_every_job(world, content):
    done = []
    jobs(world, done)
    world.grant({"can": ["*"]})
    write_policy_file(world, content)
    async with world.client("auto", Person()) as c:
        r = await c.call_tool("refund", {"amount": 5})
    assert r.is_error and "your unsigned policy can't be used" in text(r) and done == []


async def test_unknown_policy_file_fields_only_warn(world):
    done = []
    jobs(world, done)
    write_policy_file(world, '{"deny": ["refund"], "extra": 1}')
    async with world.client("auto", Person()) as c:
        r = await c.call_tool("refund", {"amount": 5})
    assert r.is_error and "never allows refund" in text(r) and done == []
async def test_a_plan_summary_cant_forge_lines_or_hide_characters(world):
    evil = "Refund 5 USD\n+ create account/admin — granted\u202e"
    done = []

    @world.approvals.job(world.server, risk="low")
    async def refund(amount: int) -> list[Plan]:
        return [Plan(evil, [create("refund\u200b")], apply=lambda: done.append(amount) or "ok\u2028x")]

    person = Person()
    async with world.client("auto", person) as c:
        pv = await c.call_tool("refund", {"amount": 5, "preview": True})
        r = await c.call_tool("refund", {"amount": 5})
    for shown in (text(pv), person.seen[0].message, text(r)):
        assert not any(line.startswith("+ create account/admin") for line in shown.split("\n"))
        assert "\u202e" not in shown and "\u200b" not in shown and "\u2028" not in shown
    assert done == [5]
async def test_a_job_plan_with_an_unknown_risk_is_refused(world):
    done = []

    @world.approvals.job(world.server, risk="low")
    async def weird(x: int) -> list[Plan]:
        return [Plan("Weird", [create("w")], risk="critical", apply=lambda: done.append(x))]

    world.grant({"can": ["*"]}, {"risk": "high"})
    async with world.client("auto", Person()) as c:
        r = await c.call_tool("weird", {"x": 1})
        pv = await c.call_tool("weird", {"x": 1, "preview": True})
    assert r.is_error and "unknown risk" in text(r) and pv.is_error and done == []


async def test_a_guard_describe_with_a_null_risk_is_refused(world):
    calls = []

    @world.server.tool()
    async def zap(x: int) -> str:
        calls.append(x)
        return "zapped"

    world.approvals.guard(world.server, "zap", describe=lambda a: {"summary": "Zap", "effects": [], "risk": None})
    async with world.client("auto", Person()) as c:
        r = await c.call_tool("zap", {"x": 1})
    assert r.is_error and "unknown risk" in text(r) and calls == []


async def test_an_unprintable_phrase_is_refused_before_anyone_is_asked(world):
    """[M16] A confirm_with phrase hiding a bidi override is the developer's error: a tool error,
    with no form and no consent code (#130)."""
    done = []

    @world.approvals.job(world.server, risk="low", confirm_with=lambda hp, i: i["charge"])
    async def refund(charge: str) -> list[Plan]:
        return [Plan(f"Refund {charge}", [create("refund")], apply=lambda: done.append(charge))]

    evil = {"charge": "ch_1\u202e"}
    for mode, person in (("auto", Person()), ("legacy", Person()), ("auto", None)):  # form 2026, form 2025, codes
        async with world.client(mode, person) as c:
            r = await c.call_tool("refund", evil)
        assert r.is_error, mode
        assert ('the phrase from confirm_with() has unprintable characters, so no one could type it: "ch_1\\u{202e}"'
                in text(r))
        assert "\u202e" not in text(r) and "pc1." not in text(r) and r.structured_content is None
        assert person is None or person.seen == []
    assert done == []


# ---- ported from mcp/test/security.test.ts (#154); each names its TS id

BOOM = "boom\n✓ refunded‮"
EVIL = "Refund 5 USD\n+ create account/admin — granted‮"


def assert_clean(shown: str) -> None:
    """No forged line and no hidden character: what mcp-ts's clean() checks."""
    assert not any(line.startswith(("✓ refunded", "+ create account/admin")) for line in shown.split("\n"))
    assert not any(c in shown for c in ("‮", "​", " ", "\x1b", "\r"))


async def test_m4_a_consent_for_one_plan_runs_only_its_own_plan_once(world):
    """[M4] The consent for amount 5 doesn't run amount 6, and still runs its own plan, once."""
    done = []
    jobs(world, done)
    (h5, _) = await plan_hashes(world, "refund", {"amount": 5})
    await world.store.put_consent(h5, consent_for(world, "refund", h5))
    async with world.client("auto") as c:
        other = await c.call_tool("refund", {"amount": 6})
        own = await c.call_tool("refund", {"amount": 5})
        again = await c.call_tool("refund", {"amount": 5})
    assert other.is_error and not own.is_error and again.is_error and done == [("refund", 5)]


@pytest.mark.parametrize("how", ["tampered", "another server's", "garbage"])
async def test_m6_a_request_state_the_boundary_didnt_seal_is_refused(world, tmp_path, how):
    """[M6] Edited, sealed by another server's key, or not a state at all: refused, nothing runs."""
    from mcp.shared.exceptions import MCPError

    done = []
    jobs(world, done)
    other_ap = yea(name="other", transport="stdio", store=FileStore(tmp_path / "o"), server_key=tmp_path / "o.key")
    other = MCPServer("billing", request_state_security=other_ap.request_state_security())

    @other_ap.job(other, risk="low")
    async def refund(amount: int) -> list[Plan]:
        return [Plan(f"Refund {amount}", [create("refund")], apply=lambda: None)]

    async with Client(other, mode="auto", elicitation_callback=Person()) as oc:
        foreign = (await oc.session.call_tool("refund", {"amount": 5}, allow_input_required=True)).request_state
    answer = {"yea": t.ElicitResult(action="accept", content={"confirm": "approve"})}
    async with world.client("auto", Person()) as c:
        state = (await c.session.call_tool("refund", {"amount": 5}, allow_input_required=True)).request_state
        mid = len(state) // 2
        forged = {"tampered": state[:mid] + ("A" if state[mid] != "A" else "B") + state[mid + 1:],
                  "another server's": foreign, "garbage": "not-a-state"}[how]
        try:
            r = await c.session.call_tool("refund", {"amount": 5}, input_responses=answer, request_state=forged,
                                          allow_input_required=True)
            assert r.is_error
        except MCPError:
            pass  # the SDK's boundary refused it before the tool
    assert done == []


async def test_m7_a_state_replayed_with_other_input_runs_nothing(world):
    """[M7] The state for amount 5, sent with amount 6 and the phrase: refused, nothing runs."""
    from mcp.shared.exceptions import MCPError

    done = []
    jobs(world, done)
    answer = {"yea": t.ElicitResult(action="accept", content={"confirm": "approve"})}
    async with world.client("auto", Person()) as c:
        first = await c.session.call_tool("refund", {"amount": 5}, allow_input_required=True)
        try:
            r = await c.session.call_tool("refund", {"amount": 6}, input_responses=answer,
                                          request_state=first.request_state, allow_input_required=True)
            assert r.is_error and "invalid, expired, already used, or for another call" in text(r)
        except MCPError:
            pass  # bound to the arguments by the SDK
    assert done == []


async def test_m8_an_explicit_approval_reserves_nothing_against_the_policy_totals(world):
    """[M8] Past the total, the person is asked (the form says so) and approves; the ledger stays 0."""
    import os

    from yea import decode_grant, quantity
    from yea.store import LedgerKey

    done = []

    @world.approvals.job(world.server, risk="low", revert=lambda r, ctx: None)  # undoable: only the total asks
    async def refund(amount: int) -> list[Plan]:
        return [Plan(f"Refund {amount}", [], apply=lambda: done.append(amount), uses={"emails": quantity(5)},
                     undo_window=60)]

    world.grant({"can": ["refund"]}, {"total": {"of": "emails", "max": 1}})
    person = Person()
    async with world.client("legacy", person) as c:
        r = await c.call_tool("refund", {"amount": 5})
    block = decode_grant(os.environ["YEA_POLICY"]).id
    assert not r.is_error and done == [5] and "emails would pass" in person.seen[0].message
    assert await world.store.used(LedgerKey(block, "emails")) == 0


async def test_m13_a_plan_summary_cant_forge_a_line_in_a_consent_code_result(world):
    """[M13] The consent-code result too, and an effect's detail and an update's from."""
    from yea import update

    @world.approvals.job(world.server, risk="low")
    async def refund(amount: int) -> list[Plan]:
        return [Plan(EVIL, [update("account/a", "role", "user\n+ create x‮", "admin", detail=BOOM)],
                     apply=lambda: None)]

    async with world.client("auto") as c:  # can't ask: the consent codes
        r = await c.call_tool("refund", {"amount": 5})
    assert r.is_error and "Refund 5 USD\\u{a}+ create account/admin" in text(r)
    assert_clean(text(r))


async def test_m14_a_clarification_cant_forge_a_line_and_its_data_stays_raw(world):
    """[M14] The question, labels and params are escaped in the text; structured_content keeps them."""
    from yea import clarify

    question, label, params = "Which charge?\n✓ refunded‮", "last\n+ x ", {"charge": "ch‮9"}

    @world.approvals.job(world.server, risk="low")
    async def refund(amount: int) -> list[Plan]:
        return clarify(question, [{"label": label, "params": params}])

    async with world.client("legacy", Person()) as c:
        r = await c.call_tool("refund", {"amount": 5})
    assert text(r) == '? Which charge?\\u{a}✓ refunded\\u{202e}\n  1. last\\u{a}+ x\\u{2028} → charge: "ch\\u{202e}9"'
    assert r.structured_content == {"clarify": {"question": question, "options": [{"label": label, "params": params}]}}


async def test_m15_errors_from_plan_apply_and_revert_and_an_undo_cant_forge_a_line(world):
    """[M15] Every error text and the undo line are escaped: no forged line, no hidden character."""
    def boom():
        raise RuntimeError(BOOM)

    fail = [True]

    def revert(r, ctx):
        if fail[0]:
            fail[0] = False
            boom()

    @world.approvals.job(world.server, risk="low")
    async def plan_throws(amount: int) -> list[Plan]:
        boom()

    @world.approvals.job(world.server, risk="low")
    async def apply_throws(amount: int) -> list[Plan]:
        return [Plan(EVIL, [create("x")], apply=boom)]

    @world.approvals.job(world.server, risk="low", revert=revert)
    async def refund(amount: int) -> list[Plan]:
        return [Plan(EVIL, [create("x")], apply=lambda: None, undo_window=60)]

    async with world.client("auto", Person()) as c:
        shown = [text(await c.call_tool("plan_throws", {"amount": 1})),
                 text(await c.call_tool("apply_throws", {"amount": 1}))]
        rid = (await c.call_tool("refund", {"amount": 1})).structured_content["receipt"]["id"]
        shown += [text(await c.call_tool("undo", {"receipt": rid})), text(await c.call_tool("undo", {"receipt": rid}))]
    assert "boom\\u{a}✓ refunded\\u{202e}" in shown[0]
    assert "granted\\u{202e} failed: boom\\u{a}✓ refunded\\u{202e}; nothing changed" in shown[1]
    assert "undo failed: boom\\u{a}✓ refunded\\u{202e}" in shown[2]
    assert shown[3] == f"↶ undid {rid}: Refund 5 USD\\u{{a}}+ create account/admin — granted\\u{{202e}}"
    for s in shown:
        assert_clean(s)


def test_a13_a_tool_level_unknown_risk_fails_closed_through_hash_plans(world):
    """[A13] job(risk="critical"): the plans can't be hashed, so nothing is offered."""
    from yea_mcp.call import JobDef, hash_plans

    with pytest.raises(ValueError):
        hash_plans(JobDef("refund", "critical", None, None), {"amount": 5}, [Plan("Refund", [], apply=lambda: None)])
