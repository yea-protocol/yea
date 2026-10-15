"""The service side. Mirrors ts/src/service.ts: ``ask`` handlers ``run(ctx)``; ``intent``
handlers ``plan(ctx)`` and return :class:`Plan` objects that carry their own ``apply`` and
``revert``. ``handle(frame, emit)`` is transport-independent.

The entry of the ``yea.service`` package: ``Service`` registers capabilities and dispatches
frames; each verb's handler lives in its own module."""

from __future__ import annotations

import time
from collections.abc import Callable
from typing import Any

from ..budget import HandleStore, MemoryHandleStore, fit
from ..grants import Trusted
from .ask import on_ask
from .capabilities import list_capabilities
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
from .state import ServiceState, _AskDef, _IntentDef
from .undo import on_undo
from .util import Emit, random_id
from .verified_request import (
    VerifiedAsk,
    VerifiedCommit,
    VerifiedExpand,
    VerifiedHello,
    VerifiedIntent,
    VerifiedUndo,
    verify_request,
)


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
        self.name, self.summary = name, summary
        self.default_budget = default_budget
        # What every verb's handler reads and changes (state.py); the properties below read it.
        self.state = ServiceState(
            id, trust if callable(trust) else list(trust), require_grants, proposal_ttl,
            handles or MemoryHandleStore(), now or time.time,
        )

    @property
    def id(self) -> str:
        return self.state.id

    @property
    def trust(self) -> Trusted:
        return self.state.trust

    @property
    def require_grants(self) -> bool:
        return self.state.require_grants

    @property
    def proposal_ttl(self) -> int:
        return self.state.proposal_ttl

    @property
    def handles(self) -> HandleStore:
        return self.state.handles

    # The state's tables, as the tests read them.
    _proposals = property(lambda self: self.state.proposals)
    _receipts = property(lambda self: self.state.receipts)
    _commits = property(lambda self: self.state.commits)
    _spent = property(lambda self: self.state.spent)
    _auto_seen = property(lambda self: self.state.auto_seen)

    def now(self) -> int:
        return self.state.now()

    def ask(self, name: str, summary: str = "", params: dict | None = None) -> Callable:
        """Register a read-only capability: ``@svc.ask(name, summary, params)`` on ``run(ctx) -> data``."""

        def deco(run: Callable) -> Callable:
            self.state.asks[name] = _AskDef(summary, params, run)
            return run

        return deco

    def intent(self, name: str, summary: str = "", params: dict | None = None, risk: str | None = None) -> Callable:
        """Register an intent: ``plan(ctx)`` returns a Plan, a list of Plans, or ``clarify(...)``."""

        def deco(plan: Callable) -> Callable:
            self.state.intents[name] = _IntentDef(summary, params, risk, plan)
            return plan

        return deco

    @property
    def capabilities(self) -> list[dict]:
        return list_capabilities(self.state)

    def brief(self, budget: int | None = None, re: str = "discover") -> dict:
        r = reply_frame(re, "BRIEF", {"service": {"id": self.id, "name": self.name, "summary": self.summary}, "capabilities": self.capabilities})
        return fit(r, budget or self.default_budget, self.handles)

    async def handle(self, frame: Any, emit: Emit | None = None) -> dict:
        """Handle one request frame: verify it, then run its verb's handler. EVENTs go to ``emit`` (a
        plain callable). Returns the final reply."""
        emit = emit or (lambda _e: None)
        re = frame["id"] if isinstance(frame, dict) and isinstance(frame.get("id"), str) else "?"
        try:
            req = verify_request(self.state, frame, self.default_budget)
            if isinstance(req, VerifiedHello):
                return self.brief(req.budget, re)
            if isinstance(req, VerifiedAsk):
                return await on_ask(self.state, req)
            if isinstance(req, VerifiedIntent):
                return await on_intent(self.state, req, emit)
            if isinstance(req, VerifiedCommit):
                return await on_commit(self.state, req, emit)
            if isinstance(req, VerifiedUndo):
                return await on_undo(self.state, req, emit)
            assert isinstance(req, VerifiedExpand)
            return on_expand(self.state, req)
        except Exception as e:  # noqa: BLE001 — every failure becomes an ERROR reply
            return error_reply(re, e)


def service(id: str, name: str, summary: str = "", **kw: Any) -> Service:
    return Service(id, name, summary, **kw)


__all__ = ["Service", "service", "Ctx", "CommitCtx", "Plan", "Clarification", "clarify", "create", "update", "remove", "send", "random_id"]
