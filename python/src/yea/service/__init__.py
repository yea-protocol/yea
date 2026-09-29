"""The service side. Mirrors ts/src/service.ts: ``ask`` handlers ``run(ctx)``; ``intent``
handlers ``plan(ctx)`` and return :class:`Plan` objects that carry their own ``apply`` and
``revert``. ``handle(frame, emit)`` is transport-independent.

The entry of the ``yea.service`` package: ``Service`` registers capabilities and dispatches
frames; each verb's handler lives in its own module."""

from __future__ import annotations

import asyncio
import time
from collections.abc import Callable
from typing import Any

from .._json import has_lone_surrogate
from ..budget import HandleStore, MemoryHandleStore, fit
from ..errors import YeaError, fix
from ..grants import Trusted
from .ask import on_ask
from .commit import on_commit
from .expand import on_expand
from .intent import on_intent
from .plan import (
    Clarification,
    CommitCtx,
    Ctx,
    Plan,
    clarify,
    create,
    remove,
    send,
    update,
)
from .replies import error_reply, reply_frame
from .state import _AskDef, _IntentDef, _StoredProposal, _StoredReceipt
from .undo import on_undo
from .util import Emit, _json_str, random_id

VERBS = ("HELLO", "ASK", "INTENT", "COMMIT", "UNDO", "EXPAND")


class Service:
    """A YEA service. Register capabilities with the :meth:`ask` and :meth:`intent` decorators."""

    def __init__(
        self,
        id: str,
        name: str,
        summary: str = "",
        *,
        trust: Trusted = (),
        require_grants: bool = False,
        default_budget: int = 2000,
        proposal_ttl: int = 600,
        handles: HandleStore | None = None,
        now: Callable[[], float] | None = None,
    ):
        self.id, self.name, self.summary = id, name, summary
        self.trust = trust if callable(trust) else list(trust)
        self.require_grants = require_grants
        self.default_budget = default_budget
        self.proposal_ttl = proposal_ttl
        self.handles = handles or MemoryHandleStore()
        self._now = now or time.time
        self._asks: dict[str, _AskDef] = {}
        self._intents: dict[str, _IntentDef] = {}
        self._proposals: dict[str, _StoredProposal] = {}
        self._commits: dict[str, asyncio.Task] = {}
        self._receipts: dict[str, _StoredReceipt] = {}
        self._spent: dict[tuple[str, str], int] = {}  # (block id, measure) -> exact value at scale 18
        self._auto_seen: dict[str, tuple[asyncio.Task, int]] = {}
        self._sweeps = 0  # INTENTs since start, for the periodic sweep (service/sweep.py)

    def now(self) -> int:
        return int(self._now())

    def ask(self, name: str, summary: str = "", params: dict | None = None) -> Callable:
        """Register a read-only capability: ``@svc.ask(name, summary, params)`` on ``run(ctx) -> data``."""

        def deco(run: Callable) -> Callable:
            self._asks[name] = _AskDef(summary, params, run)
            return run

        return deco

    def intent(self, name: str, summary: str = "", params: dict | None = None, risk: str | None = None) -> Callable:
        """Register an intent: ``plan(ctx)`` returns a Plan, a list of Plans, or ``clarify(...)``."""

        def deco(plan: Callable) -> Callable:
            self._intents[name] = _IntentDef(summary, params, risk, plan)
            return plan

        return deco

    @property
    def capabilities(self) -> list[dict]:
        out: list[dict] = []
        for name, a in self._asks.items():
            out.append({"name": name, "kind": "ask", "summary": a.summary, **({"params": a.params} if a.params else {})})
        for name, i in self._intents.items():
            c: dict[str, Any] = {"name": name, "kind": "intent", "summary": i.summary}
            if i.params:
                c["params"] = i.params
            if i.risk:
                c["risk"] = i.risk
            out.append(c)
        return out

    def brief(self, budget: int | None = None, re: str = "discover") -> dict:
        r = reply_frame(re, "BRIEF", {"service": {"id": self.id, "name": self.name, "summary": self.summary}, "capabilities": self.capabilities})
        return fit(r, budget or self.default_budget, self.handles)

    async def handle(self, frame: Any, emit: Emit | None = None) -> dict:
        """Handle one request frame; EVENTs go to ``emit`` (a plain callable). Returns the final reply."""
        emit = emit or (lambda _e: None)
        re = frame["id"] if isinstance(frame, dict) and isinstance(frame.get("id"), str) else "?"
        try:
            if not isinstance(frame, dict) or frame.get("yea") != 1 or not isinstance(frame.get("id"), str):
                raise YeaError("bad_frame", 'frames need "yea": 1 and a string "id"')
            # A lone surrogate has no canonical form (SPEC §10): refuse the frame here, before a
            # handler hashes it and fails as `internal`.
            if has_lone_surrogate(frame):
                raise YeaError("bad_frame", "a string holds a lone surrogate")
            budget = _positive_int(frame.get("budget")) or self.default_budget
            verb = frame.get("verb")
            if verb == "HELLO":
                return self.brief(budget, re)
            if verb == "ASK":
                return await on_ask(self, frame, budget)
            if verb == "INTENT":
                return await on_intent(self, frame, budget, emit)
            if verb == "COMMIT":
                return await on_commit(self, frame, budget, emit)
            if verb == "UNDO":
                return await on_undo(self, frame, budget, emit)
            if verb == "EXPAND":
                return on_expand(self, frame, budget)
            raise YeaError("bad_frame", f"unknown verb {_json_str(verb)}", fix=[fix("use one of " + ", ".join(VERBS))])
        except Exception as e:  # noqa: BLE001 — every failure becomes an ERROR reply
            return error_reply(re, e)


def _positive_int(v: Any) -> int | None:
    """A whole number above 0, as TS's ``Number.isInteger`` sees it: ``800.0`` and ``1e3`` count,
    since JSON can't tell them from ``800`` and ``1000``. Booleans don't."""
    if type(v) is float and v.is_integer():
        v = int(v)
    return v if type(v) is int and v > 0 else None


def service(id: str, name: str, summary: str = "", **kw: Any) -> Service:
    return Service(id, name, summary, **kw)


__all__ = ["Service", "service", "Ctx", "CommitCtx", "Plan", "Clarification", "clarify", "create", "update", "remove", "send", "random_id"]
