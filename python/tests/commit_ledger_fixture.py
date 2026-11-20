"""A commit ledger with no service around it, for tests at its interface: no keys, no proofs and no
sleeps. Grant evaluation is a stand-in that judges one ``total`` as the caveat rule does. Like
ts/test/commit-ledger-fixture.ts."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

from yea import GrantContext, YeaError, create, quantity, verify_grant
from yea.service.commit_ledger import Admit, Admitted, Commit, CommitLedger, StoredProposal, TotalLimit, Used
from yea.service.plan import Plan
from yea.store import LedgerKey
from yea.uses import value

T0 = 1_790_000_000


class LedgerFixture:
    """A ledger on a clock the test moves, and proposals to pay ``cents`` made for alice by her agent."""

    def __init__(self) -> None:
        self.t = T0
        self.ledger = CommitLedger("pay", lambda: self.t)
        self._n = 0

    def advance(self, seconds: int) -> None:
        self.t += seconds

    def propose(self, cents: int, apply: Callable[..., Any] | None = None, revert: Callable[..., Any] | None = None,
                undo_window: int | None = None) -> StoredProposal:
        self._n += 1
        pid = f"p_{self._n}"
        proposal = {
            "id": pid, "capability": "pay.send", "summary": f"pay {cents}", "effects": [create(f"payment/{pid}")],
            "uses": {"spend": quantity(cents, scale=2, unit="USD")}, "risk": "low",
            "undo": {"window": 600 if undo_window is None else undo_window} if revert else None,
            "expires": self.t + 600, "hash": f"h_{pid}",
        }
        plan = Plan("pay", [], apply or (lambda c: None), revert=revert, undo_window=undo_window)
        stored = StoredProposal(proposal, plan, "alice", "agent")
        self.ledger.propose([stored])
        return stored


class TotalGrant:
    """Grant evaluation for a grant from ``iss`` with a ``total`` of ``max_cents`` on spend: past what
    the usage ledger holds, it needs consent. ``calls`` counts the evaluations."""

    KEY = LedgerKey("b_1", "spend")

    def __init__(self, max_cents: int, iss: str = "alice") -> None:
        self.max = value({"amount": max_cents, "scale": 2})
        self.iss = iss
        self.calls = 0

    def admit(self, proposal: dict, used: Used) -> Admitted | YeaError:
        self.calls += 1
        q = proposal.get("uses", {}).get("spend")
        if q and used.get(self.KEY, 0) + value(q) > self.max:
            return YeaError("consent_required", "spend would pass the total limit")
        return Admitted(self.iss, [TotalLimit(self.KEY, self.max)])


def grant_admit(grant: Any, holder: str, trusted: str, at: Callable[[], int]) -> Admit:
    """Grant evaluation as a service runs it, with the limits (verified_request/identity.py): the real
    check of ``grant``, held by ``holder`` and issued by ``trusted``, at the time ``at`` gives."""

    def admit(proposal: dict, used: Used) -> Admitted | YeaError:
        checked = {k: proposal[k] for k in ("hash", "risk", "uses") if k in proposal}
        ctx = GrantContext("pay", "COMMIT", proposal["capability"], at(), checked, used)
        v = verify_grant(grant, [trusted], holder, ctx)
        return Admitted(v.principal or "", v.totals) if v.ok else YeaError(v.code or "forbidden", v.reason)

    return admit


def commit_of(stored: StoredProposal, admit: Admit, principal: str = "alice") -> Commit:
    """A COMMIT of ``stored`` by ``principal``'s agent, under ``admit``."""
    return Commit(f"c_{stored.proposal['id']}", stored, principal, admit)


async def code_of(call: Awaitable[Any]) -> str:
    """The error code a ledger call raises, or ``ok``."""
    try:
        await call
    except YeaError as e:
        return e.code
    return "ok"
