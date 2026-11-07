"""The commit ledger (yea/service/commit_ledger) at its interface: replays, limits, expiry, sweep,
undo and auto-commit, with no keys, proofs or sleeps; and the COMMIT and UNDO handlers that fit its
receipts to the budget. Mirrors ts/test/commit-ledger.test.ts one for one; its security cases
([H2], [U5], [U5b]) are in test_security.py. Two sections TS has no need for follow: a cancelled
caller, and a second event loop."""

import asyncio
from types import SimpleNamespace

import pytest
from commit_ledger_fixture import T0, LedgerFixture, TotalGrant, code_of, commit_of

from yea import YeaError, create, update
from yea.budget import MemoryHandleStore
from yea.service.commit import on_commit
from yea.service.commit_ledger import Answer, AutoReplay, Undo
from yea.service.replies import reply_frame
from yea.service.undo import on_undo
from yea.service.verified_request import VerifiedCommit, VerifiedUndo

DAY = 86_400


def no_events(_e):
    pass


def run(coro):
    return asyncio.run(coro)


# ------------------------------------------------------------ commit replays


def test_replays_a_receipt_to_its_principal_only():
    async def go():
        f, grant = LedgerFixture(), TotalGrant(100)
        p = f.propose(10)
        first = await f.ledger.commit(commit_of(p, grant.admit), no_events)
        again = await f.ledger.commit(commit_of(p, grant.admit), no_events)
        assert (again["replay"], again["receipt"]) == (True, first["receipt"])
        eve = commit_of(p, TotalGrant(100, "eve").admit, "eve")
        assert await code_of(f.ledger.commit(eve, no_events)) == "forbidden"

    run(go())


def test_replays_a_commit_after_its_limit_filled_with_no_limit_evaluated_again():
    """§4.4"""

    async def go():
        f, grant = LedgerFixture(), TotalGrant(60)
        p = f.propose(60)
        assert (await f.ledger.commit(commit_of(p, grant.admit), no_events))["kind"] == "RECEIPT"
        f.advance(3600)  # past its expiry, too: the commit already happened
        again = await f.ledger.commit(commit_of(p, grant.admit), no_events)
        assert again["replay"] is True and grant.calls == 1
        assert await code_of(f.ledger.commit(commit_of(f.propose(1), grant.admit), no_events)) == "consent_required"

    run(go())


# ------------------------------------------------------------ a new commit


def test_raises_the_error_grant_evaluation_gives_and_runs_nothing():
    async def go():
        f, runs = LedgerFixture(), []
        p = f.propose(10, apply=lambda c: runs.append(1))

        def refuse(proposal, used):
            return YeaError("forbidden", "grant does not cover it")

        assert await code_of(f.ledger.commit(commit_of(p, refuse), no_events)) == "forbidden"
        assert runs == []

    run(go())


def test_refuses_an_expired_proposal():
    async def go():
        f = LedgerFixture()
        p = f.propose(10)
        f.advance(600)
        assert await code_of(f.ledger.commit(commit_of(p, TotalGrant(100).admit), no_events)) == "expired"

    run(go())


def test_refuses_an_expired_proposal_before_its_limits_so_it_never_asks_for_consent():
    async def go():
        f, grant = LedgerFixture(), TotalGrant(5)
        p = f.propose(10)
        f.advance(600)
        assert await code_of(f.ledger.commit(commit_of(p, grant.admit), no_events)) == "expired"
        assert grant.calls == 0

    run(go())


def test_settles_the_spend_of_a_commit_that_applied():
    async def go():
        f, grant = LedgerFixture(), TotalGrant(100)

        def commit(cents):
            return code_of(f.ledger.commit(commit_of(f.propose(cents), grant.admit), no_events))

        assert [await commit(70), await commit(31), await commit(30)] == ["ok", "consent_required", "ok"]

    run(go())


def test_sends_the_plans_progress_as_events_on_the_frame_it_answers():
    async def go():
        f, events = LedgerFixture(), []
        p = f.propose(10, apply=lambda c: c.progress("charging", 0.5))
        await f.ledger.commit(commit_of(p, TotalGrant(100).admit), events.append)
        assert [(e["re"], e["message"], e["progress"]) for e in events] == [(f"c_{p.proposal['id']}", "charging", 0.5)]

    run(go())


def test_a_replay_whose_receipt_is_gone_is_refused_not_crashed():
    """Python only: the replay looks its receipt up with ``.get()``. Sweep forgets a receipt and its run
    together, so only reaching into the records can part them."""

    async def go():
        f, grant = LedgerFixture(), TotalGrant(100)
        p = f.propose(10)
        await f.ledger.commit(commit_of(p, grant.admit), no_events)
        f.ledger._records.receipts.clear()
        return await code_of(f.ledger.commit(commit_of(p, grant.admit), no_events))

    assert run(go()) == "forbidden"


# ------------------------------------------------------------ sweep


def test_keeps_a_proposal_while_its_commit_is_in_flight_and_forgets_it_a_day_after_its_receipt():
    async def go():
        f, started, held = LedgerFixture(), asyncio.Event(), asyncio.Event()

        async def apply(c):
            started.set()
            await held.wait()

        p = f.propose(10, apply=apply)
        pid = p.proposal["id"]
        commit = asyncio.ensure_future(f.ledger.commit(commit_of(p, TotalGrant(100).admit), no_events))
        await started.wait()
        f.advance(2 * 3600)
        f.ledger.sweep()
        assert f.ledger.proposal(pid) is p
        held.set()
        rid = (await commit)["receipt"]["id"]
        f.ledger.sweep()
        assert f.ledger.receipt(rid).principal == "alice"
        f.advance(DAY + 1)
        f.ledger.sweep()
        assert (f.ledger.proposal(pid), f.ledger.receipt(rid)) == (None, None)

    run(go())


def test_forgets_an_expired_proposal_no_one_committed_an_hour_after_it_expires():
    f = LedgerFixture()
    p = f.propose(10)
    f.advance(600 + 3600)
    f.ledger.sweep()
    assert f.ledger.proposal(p.proposal["id"]) is p
    f.advance(1)
    f.ledger.sweep()
    assert f.ledger.proposal(p.proposal["id"]) is None


# ------------------------------------------------------------ undo


async def receipted(revert=lambda c: None, effects=None):
    """A receipt for an undoable payment, how many times its revert ran, and an UNDO of it."""
    f, reverts = LedgerFixture(), []

    def counted(c):
        reverts.append(1)
        return revert(c)

    p = f.propose(10, revert=counted)
    if effects is not None:
        p.proposal["effects"] = effects
    out = await f.ledger.commit(commit_of(p, TotalGrant(100).admit), no_events)
    stored = f.ledger.receipt(out["receipt"]["id"])

    def undo():
        return f.ledger.undo(Undo("u1", stored, "alice"), no_events)

    return SimpleNamespace(f=f, reverts=reverts, stored=stored, undo=undo)


def test_reverts_once_when_two_undos_race_and_replays_the_reversal():
    async def go():
        held = asyncio.Event()

        async def revert(c):
            await held.wait()

        r = await receipted(revert)
        both = asyncio.gather(r.undo(), r.undo())
        held.set()
        u1, u2 = await both
        assert r.reverts == [1]
        rid = r.stored.receipt["id"]
        assert [(u["receipt"]["undoes"], bool(u.get("replay"))) for u in (u1, u2)] == [(rid, False), (rid, True)]

    run(go())


def test_retries_a_revert_that_failed():
    async def go():
        failures = ["bank down"]

        def revert(c):
            if failures:
                raise RuntimeError(failures.pop())

        r = await receipted(revert)
        assert [(await r.undo())["kind"], (await r.undo())["kind"]] == ["ERROR", "RECEIPT"]
        assert r.reverts == [1, 1]

    run(go())


def test_refuses_once_the_undo_window_closes_and_for_a_plan_with_no_revert():
    async def go():
        r = await receipted()
        r.f.advance(601)
        assert await code_of(r.undo()) == "expired"
        f = LedgerFixture()
        out = await f.ledger.commit(commit_of(f.propose(10), TotalGrant(100).admit), no_events)
        stored = f.ledger.receipt(out["receipt"]["id"])
        assert await code_of(f.ledger.undo(Undo("u1", stored, "alice"), no_events)) == "forbidden"

    run(go())


def test_an_undo_swaps_only_the_sides_an_update_had():
    """Python only, moved from test_service.py: a side the original left out stays left out, never
    null, and an explicit null still swaps (§4.5, #159); keys keep TS's order."""

    async def go():
        effects = [
            update("t", "f", None, 2), {"op": "update", "target": "t", "field": "f", "to": 2},
            {"op": "update", "from": 1, "target": "t", "to": 2}, create("c"),
        ]
        r = await receipted(effects=effects)
        undone = (await r.undo())["receipt"]["effects"]
        assert undone[:2] == [
            {"op": "update", "target": "t", "field": "f", "from": 2, "to": None},
            {"op": "update", "target": "t", "field": "f", "from": 2},
        ]
        assert list(undone[2]) == ["op", "target", "from", "to"]
        assert undone[3] == {"op": "delete", "target": "c"}

    run(go())


# ------------------------------------------------------------ auto-commit (§4.3.1)

ANSWER = Answer("i1", no_events)


def test_commits_an_undoable_proposal_its_grant_admits():
    async def go():
        f = LedgerFixture()
        p = f.propose(10, revert=lambda c: None)
        out = await f.ledger.auto_commit(p, TotalGrant(100).admit, ANSWER)
        assert out["receipt"]["proposal"] == p.proposal["id"]

    run(go())


def test_leaves_a_proposal_when_it_is_irreversible_has_no_undo_window_or_its_grant_refuses():
    async def go():
        f, grant = LedgerFixture(), TotalGrant(5)
        assert await f.ledger.auto_commit(f.propose(1), grant.admit, ANSWER) is None
        no_window = f.propose(1, revert=lambda c: None, undo_window=0)
        assert await f.ledger.auto_commit(no_window, grant.admit, ANSWER) is None
        assert grant.calls == 0
        assert await f.ledger.auto_commit(f.propose(10, revert=lambda c: None), grant.admit, ANSWER) is None

    run(go())


def test_leaves_a_proposal_when_a_commit_in_flight_took_the_room_under_its_total():
    async def go():
        f, grant = LedgerFixture(), TotalGrant(100)
        a, b = f.propose(60, revert=lambda c: None), f.propose(60, revert=lambda c: None)
        ra, rb = await asyncio.gather(
            f.ledger.commit(commit_of(a, grant.admit), no_events), f.ledger.auto_commit(b, grant.admit, ANSWER))
        assert [ra["kind"], rb] == ["RECEIPT", None]

    run(go())


# ------------------------------------------------------------ auto INTENT replays (§4.3.1)


def answers_counted(answers, kind="ANSWER"):
    async def answer():
        answers.append(1)
        return reply_frame("f1", kind, {"data": len(answers)})

    return answer


def test_answers_a_repeat_with_the_original_reply_as_a_new_frame_until_900s_past_the_proof():
    async def go():
        f, answers = LedgerFixture(), []
        replay, answer = AutoReplay("agent:f1", T0), answers_counted(answers)
        first = await f.ledger.answer_once(replay, "f1", answer)
        again = await f.ledger.answer_once(replay, "f1b", answer)
        assert len(answers) == 1 and (again["data"], again["re"]) == (1, "f1b") and again["id"] != first["id"]
        f.advance(900)
        await f.ledger.answer_once(replay, "f1c", answer)
        assert len(answers) == 2

    run(go())


def test_keeps_a_reply_900s_past_a_proof_ts_ahead_of_the_clock():
    """Python only, moved from test_service.py: proofs are valid 300s around ``ts``, so a reply is kept
    900s past the later of its arrival and its proof's ``ts``."""

    async def go():
        f, answers = LedgerFixture(), []
        replay, answer = AutoReplay("agent:f1", T0 + 300), answers_counted(answers)
        await f.ledger.answer_once(replay, "f1", answer)
        f.advance(300 + 899)
        await f.ledger.answer_once(replay, "f1b", answer)
        assert len(answers) == 1
        f.advance(1)
        await f.ledger.answer_once(replay, "f1c", answer)
        assert len(answers) == 2

    run(go())


# ------------------------------------------------------------ replies fit the budget (§8)
# #279: a replay used to skip `fit`, so it carried the whole receipt whatever budget the repeat
# asked for. SPEC §8: a service SHOULD fit every reply to its request's budget.

LINES = [f"ledger line {i}" for i in range(200)]


async def receipted_long():
    """A receipted payment whose result is long, and its COMMIT and UNDO handlers with a budget."""
    f, handles = LedgerFixture(), MemoryHandleStore()
    state = SimpleNamespace(ledger=f.ledger, handles=handles)
    p = f.propose(10, apply=lambda c: {"lines": LINES}, revert=lambda c: None)
    admit = TotalGrant(100).admit

    def commit(budget):
        return on_commit(state, VerifiedCommit("c1", budget, p, "agent", "alice", admit), no_events)

    first = await commit(100_000)
    stored = f.ledger.receipt(first["receipt"]["id"])

    def undo(budget):
        return on_undo(state, VerifiedUndo("u1", budget, stored, "agent", "alice"), no_events)

    return SimpleNamespace(first=first, commit=commit, undo=undo, handles=handles)


def test_fits_a_commit_replay_to_the_repeats_budget_parking_the_rest_for_the_holder():
    async def go():
        r = await receipted_long()
        replay = await r.commit(60)
        assert r.first["receipt"]["result"] == {"lines": LINES} and r.first.get("more", []) == []
        assert replay["replay"] is True and replay["receipt"].get("result") != {"lines": LINES}
        more = replay["more"][0]
        assert r.handles.get(more["handle"])[1] == "agent"

    run(go())


def test_fits_an_undo_replay_too_a_reversal_has_no_result_to_cut_so_it_stays_whole():
    async def go():
        r = await receipted_long()
        reversal = await r.undo(100_000)
        replay = await r.undo(1)
        assert replay["replay"] is True
        assert (replay["receipt"], replay.get("more", [])) == (reversal["receipt"], [])

    run(go())


# ------------------------------------------------------------ a cancelled caller (Python only)
# A transport may cancel a request's task when its client goes away. The run it started is shielded:
# it runs once, settles or releases as it finishes, and a retry is a replay (runs.py).


async def cancelled(call):
    """Start ``call``, cancel it once ``call.started`` is set, and check it raised CancelledError."""
    task = asyncio.ensure_future(call.run())
    await call.started.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task


def held_apply(runs, fail_first=False):
    """An apply that waits for ``held``, counting its runs; it fails the first time if asked."""
    gate = SimpleNamespace(started=asyncio.Event(), held=asyncio.Event())

    async def apply(c):
        runs.append(1)
        gate.started.set()
        await gate.held.wait()
        if fail_first and len(runs) == 1:
            raise RuntimeError("card declined")

    return gate, apply


def test_a_commit_whose_caller_is_cancelled_mid_apply_still_runs_once_and_settles():
    async def go():
        f, grant, runs = LedgerFixture(), TotalGrant(100), []
        gate, apply = held_apply(runs)
        p = f.propose(60, apply=apply)
        commit = SimpleNamespace(started=gate.started, run=lambda: f.ledger.commit(commit_of(p, grant.admit), no_events))
        await cancelled(commit)
        gate.held.set()
        again = await commit.run()
        assert again["replay"] is True and runs == [1]
        # Settled: 60 of the 100 is used, so 41 is over and 40 fits.
        assert await code_of(f.ledger.commit(commit_of(f.propose(41), grant.admit), no_events)) == "consent_required"
        assert await code_of(f.ledger.commit(commit_of(f.propose(40), grant.admit), no_events)) == "ok"

    run(go())


def test_a_commit_whose_caller_is_cancelled_releases_its_reservation_when_apply_then_fails():
    async def go():
        f, grant, runs = LedgerFixture(), TotalGrant(100), []
        gate, apply = held_apply(runs, fail_first=True)
        p = f.propose(60, apply=apply)
        commit = SimpleNamespace(started=gate.started, run=lambda: f.ledger.commit(commit_of(p, grant.admit), no_events))
        await cancelled(commit)
        gate.held.set()
        assert (await commit.run())["code"] == "internal"  # the failed run's own outcome, as it finished
        retried = await commit.run()  # 60 more would pass the 100 if the failure hadn't released its 60
        assert retried["kind"] == "RECEIPT" and "replay" not in retried and runs == [1, 1]

    run(go())


def test_an_apply_that_raises_cancelled_error_fails_like_any_error_and_never_reaches_a_caller():
    async def go():
        f, grant, runs = LedgerFixture(), TotalGrant(100), []

        def apply(c):
            runs.append(1)
            if len(runs) == 1:
                raise asyncio.CancelledError

        p = f.propose(60, apply=apply)
        assert (await f.ledger.commit(commit_of(p, grant.admit), no_events))["code"] == "internal"
        retried = await f.ledger.commit(commit_of(p, grant.admit), no_events)
        assert retried["kind"] == "RECEIPT" and "replay" not in retried and runs == [1, 1]

    run(go())


def test_a_revert_or_an_auto_intent_that_raises_cancelled_error_fails_like_any_error():
    async def go():
        failures = [asyncio.CancelledError]

        def revert(c):
            if failures:
                raise failures.pop()

        r = await receipted(revert)
        assert [(await r.undo())["kind"], (await r.undo())["kind"]] == ["ERROR", "RECEIPT"]

        async def answer():
            raise asyncio.CancelledError

        replay = AutoReplay("agent:f1", T0)
        for re in ("f1", "f1b"):  # the first answer, then its replay
            with pytest.raises(RuntimeError, match="cancelled while it ran"):
                await r.f.ledger.answer_once(replay, re, answer)

    run(go())


def test_an_undo_whose_caller_is_cancelled_mid_revert_still_runs_once():
    async def go():
        gate = SimpleNamespace(started=asyncio.Event(), held=asyncio.Event())

        async def revert(c):
            gate.started.set()
            await gate.held.wait()

        r = await receipted(revert)
        await cancelled(SimpleNamespace(started=gate.started, run=r.undo))
        gate.held.set()
        again = await r.undo()
        assert again["replay"] is True and again["receipt"]["undoes"] == r.stored.receipt["id"] and r.reverts == [1]

    run(go())


def test_an_auto_intent_whose_caller_is_cancelled_mid_plan_still_answers_once():
    async def go():
        f, answers = LedgerFixture(), []
        gate = SimpleNamespace(started=asyncio.Event(), held=asyncio.Event())
        replay = AutoReplay("agent:f1", T0)

        async def answer():
            answers.append(1)
            gate.started.set()
            await gate.held.wait()
            return reply_frame("f1", "RECEIPT", {"receipt": {"id": "r_1"}, "auto": True})

        await cancelled(SimpleNamespace(started=gate.started, run=lambda: f.ledger.answer_once(replay, "f1", answer)))
        gate.held.set()
        again = await f.ledger.answer_once(replay, "f1b", answer)
        assert (again["replay"], again["re"], answers) == (True, "f1b", [1])

    run(go())


# ------------------------------------------------------------ a run cancelled before it starts (Python only)
# A run's first step comes a loop iteration after it is made. A loop closed in between (asyncio.run
# of a handler fired and not awaited) cancels it before its own failure handling can run, so the
# ledger forgets it as it would a failed run, releasing what it held, and a retry starts it afresh.


async def fired(call):
    """Start ``call`` and return at once: asyncio.run then closes the loop before its run starts."""
    asyncio.ensure_future(call)


def test_a_commit_run_cancelled_before_it_starts_is_forgotten_and_releases_its_reservation():
    f, grant, runs = LedgerFixture(), TotalGrant(100), []
    p = f.propose(60, apply=lambda c: runs.append(1))

    def commit(stored):
        return f.ledger.commit(commit_of(stored, grant.admit), no_events)

    run(fired(commit(p)))
    assert runs == []
    retried = run(commit(p))  # 60 more would pass the 100 had the first 60 stayed reserved
    assert retried["kind"] == "RECEIPT" and "replay" not in retried and runs == [1]
    assert run(code_of(commit(f.propose(40)))) == "ok"


def test_an_undo_run_cancelled_before_it_starts_is_forgotten():
    r = run(receipted())
    run(fired(r.undo()))
    assert r.reverts == []
    again = run(r.undo())
    assert again["kind"] == "RECEIPT" and "replay" not in again and r.reverts == [1]


def test_an_auto_answer_cancelled_before_it_starts_is_forgotten():
    f, answers = LedgerFixture(), []
    replay, answer = AutoReplay("agent:f1", T0), answers_counted(answers)
    run(fired(f.ledger.answer_once(replay, "f1", answer)))
    assert answers == []
    run(f.ledger.answer_once(replay, "f1b", answer))
    assert answers == [1]  # answered afresh: no reply was kept for the cancelled one


def test_no_caller_receives_a_runs_own_cancellation():
    """``runs.outcome`` itself: a caller can still reach a cancelled run in the iteration before the
    ledger forgets it, already done or while it waits. It gets ``internal``, never the cancellation."""
    from yea.service.commit_ledger.runs import outcome

    async def go():
        gate = asyncio.Event()

        async def reply():
            await gate.wait()
            return {}

        cancelled_run = asyncio.ensure_future(reply())
        waiter = asyncio.ensure_future(outcome(cancelled_run))
        await asyncio.sleep(0)  # a yield, so the waiter is waiting on the run
        cancelled_run.cancel()
        for caller in (waiter, outcome(cancelled_run)):
            with pytest.raises(YeaError, match="was cancelled before it started") as e:
                await caller
            assert e.value.code == "internal"

    run(go())


# ------------------------------------------------------------ a second event loop (Python only)


def test_a_replay_from_another_event_loop_reads_a_finished_run_and_refuses_one_in_flight():
    """One Service serves one event loop. A run in flight on another loop can't be waited on, so its
    replay is ``internal`` with the reason, not a traceback; a finished one is read as is."""
    f, grant = LedgerFixture(), TotalGrant(100)

    async def start():
        gate = SimpleNamespace(started=asyncio.Event(), held=asyncio.Event())

        async def apply(c):
            gate.started.set()
            await gate.held.wait()

        p = f.propose(10, apply=apply)
        first = asyncio.ensure_future(f.ledger.commit(commit_of(p, grant.admit), no_events))
        await gate.started.wait()
        return p, gate, first

    loop = asyncio.new_event_loop()
    try:
        p, gate, first = loop.run_until_complete(start())  # stops with the run in flight on `loop`
        with pytest.raises(YeaError) as e:
            run(f.ledger.commit(commit_of(p, grant.admit), no_events))
        assert e.value.code == "internal" and "in flight on another event loop" in e.value.message
        gate.held.set()
        receipt = loop.run_until_complete(first)["receipt"]
    finally:
        loop.close()
    again = run(f.ledger.commit(commit_of(p, grant.admit), no_events))
    assert (again["replay"], again["receipt"]) == (True, receipt)
