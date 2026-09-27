"""The service side. Mirrors ts/src/service.ts: ``ask`` handlers ``run(ctx)``; ``intent``
handlers ``plan(ctx)`` and return :class:`Plan` objects that carry their own ``apply`` and
``revert``. ``handle(frame, emit)`` is transport-independent."""

from __future__ import annotations

import asyncio
import inspect
import logging
import os
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from ._json import b64url_encode, compact, proposal_hash
from .budget import HandleStore, MemoryHandleStore, fit
from .errors import YeaError, fix
from .grants import GrantContext, Trusted, Verification, verify_grant
from .keys import verify_proof
from .uses import check_uses, limit_value, same_unit, value
from .validate import closest, validate_params

log = logging.getLogger("yea")

DAY = 86400
AUTO_MEMORY = 900  # seconds past max(arrival, proof.ts) a (key, frame id) auto INTENT is remembered (§4.3.1)
VERBS = ("HELLO", "ASK", "INTENT", "COMMIT", "UNDO", "EXPAND")
Emit = Callable[[dict], None]
_UNSET: Any = object()


def random_id(prefix: str, nbytes: int = 6) -> str:
    return f"{prefix}_{b64url_encode(os.urandom(nbytes))}"


async def _call(fn: Callable, *args: Any) -> Any:
    r = fn(*args)
    return await r if inspect.isawaitable(r) else r


# ------------------------------------------------------------ handler-facing types


@dataclass
class Ctx:
    """Passed to ``run`` and ``plan``."""

    params: dict
    principal: str | None  # the principal behind a valid grant, if the agent presented one
    goal: str | None = None
    agent: dict | None = None


@dataclass
class CommitCtx:
    """Passed to ``Plan.apply`` and ``Plan.revert`` (which also gets ``result``)."""

    principal: str
    _emit: Callable[[str, float | None, Any], None]
    result: Any = None

    def progress(self, message: str, progress: float | None = None, data: Any = None) -> None:
        """Stream progress to the agent as an EVENT frame."""
        self._emit(message, progress, data)


@dataclass
class Plan:
    """One way to satisfy an intent. Becomes a proposal; ``apply`` runs only on COMMIT."""

    summary: str
    effects: list[dict]
    apply: Callable[[CommitCtx], Any]
    uses: dict | None = None  # SPEC §5.1, e.g. {"spend": spend("22.87", "USD"), "emails": quantity(1)}
    risk: str | None = None
    expires_in: int | None = None  # seconds; default is the service's proposal_ttl
    data: Any = _UNSET
    revert: Callable[[CommitCtx], Any] | None = None  # makes the proposal undoable
    undo_window: int | None = None  # seconds; default one day when revert is set


def _checked(proposal: dict) -> dict:
    """The parts of a proposal that COMMIT caveats read (§6.3)."""
    out = {"hash": proposal["hash"], "risk": proposal["risk"]}
    if "uses" in proposal:
        out["uses"] = proposal["uses"]
    return out


@dataclass
class Clarification:
    question: str
    options: list[dict]  # [{"label": str, "params": mergePatch}]


def clarify(question: str, options: list[dict]) -> Clarification:
    """Return from ``plan`` when the intent is ambiguous (SPEC §4.3)."""
    return Clarification(question, options)


# Effect helpers (SPEC §5.1).
def _effect(op: str, target: str, detail: str | None, **kw: Any) -> dict:
    e = {"op": op, "target": target, **kw}
    if detail:
        e["detail"] = detail
    return e


def create(target: str, detail: str | None = None) -> dict:
    return _effect("create", target, detail)


def update(target: str, field: str, from_: Any, to: Any, detail: str | None = None) -> dict:
    return _effect("update", target, detail, field=field, **{"from": from_, "to": to})


def remove(target: str, detail: str | None = None) -> dict:
    return _effect("delete", target, detail)


def send(target: str, detail: str | None = None) -> dict:
    return _effect("send", target, detail)


@dataclass
class _AskDef:
    summary: str
    params: dict | None
    run: Callable


@dataclass
class _IntentDef:
    summary: str
    params: dict | None
    risk: str | None
    plan: Callable


@dataclass
class _StoredProposal:
    proposal: dict
    plan: Plan
    principal: str | None  # the principal whose grant authorized the INTENT, if any
    requester: str | None  # the holder key whose verified proof was on the INTENT (§4.4)


@dataclass
class _StoredReceipt:
    receipt: dict
    plan: Plan
    result: Any
    principal: str
    undone: asyncio.Task | None = None


_INVERSE = {"create": "delete", "delete": "create"}


def _inverse(e: dict) -> dict:
    op = e.get("op")
    if op == "update":
        return {**e, "from": e.get("to"), "to": e.get("from")}
    if op == "send":
        return {"op": "other", "target": e["target"], "detail": "cannot unsend; follow-up sent if supported"}
    return {**e, "op": _INVERSE.get(op, "other")}


# ------------------------------------------------------------ service


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

    def now(self) -> int:
        return int(self._now())

    # ------------------------------------------------------------ registration

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

    # ------------------------------------------------------------ dispatch

    def _frame(self, re: str, kind: str, body: dict) -> dict:
        return {"yea": 1, "id": random_id("s"), "re": re, "kind": kind, **body}

    def brief(self, budget: int | None = None, re: str = "discover") -> dict:
        r = self._frame(re, "BRIEF", {"service": {"id": self.id, "name": self.name, "summary": self.summary}, "capabilities": self.capabilities})
        return fit(r, budget or self.default_budget, self.handles)

    async def handle(self, frame: Any, emit: Emit | None = None) -> dict:
        """Handle one request frame; EVENTs go to ``emit`` (a plain callable). Returns the final reply."""
        emit = emit or (lambda _e: None)
        re = frame["id"] if isinstance(frame, dict) and isinstance(frame.get("id"), str) else "?"
        try:
            if not isinstance(frame, dict) or frame.get("yea") != 1 or not isinstance(frame.get("id"), str):
                raise YeaError("bad_frame", 'frames need "yea": 1 and a string "id"')
            b = frame.get("budget")
            budget = b if type(b) is int and b > 0 else self.default_budget
            verb = frame.get("verb")
            if verb == "HELLO":
                return self.brief(budget, re)
            if verb == "ASK":
                return await self._on_ask(frame, budget)
            if verb == "INTENT":
                return await self._on_intent(frame, budget, emit)
            if verb == "COMMIT":
                return await self._on_commit(frame, budget, emit)
            if verb == "UNDO":
                return await self._on_undo(frame, budget, emit)
            if verb == "EXPAND":
                return self._on_expand(frame, budget)
            raise YeaError("bad_frame", f"unknown verb {_json_str(verb)}", fix=[fix("use one of " + ", ".join(VERBS))])
        except Exception as e:  # noqa: BLE001 — every failure becomes an ERROR reply
            return self._error_reply(re, e)

    def _error_reply(self, re: str, e: BaseException) -> dict:
        if isinstance(e, YeaError):
            return self._frame(re, "ERROR", e.body())
        log.exception("handler failed", exc_info=e)
        return self._frame(re, "ERROR", {"code": "internal", "message": "the service failed unexpectedly", "retry": 5})

    def _unknown_capability(self, name: Any, kind: str) -> YeaError:
        other = self._intents if kind == "ask" else self._asks
        if isinstance(name, str) and name in other:
            verb = "INTENT" if kind == "ask" else "ASK"
            return YeaError(
                "unknown_capability", f"{name} is {'an intent' if kind == 'ask' else 'an ask'} capability", fix=[fix(f"send it with {verb}")]
            )
        everything = [*self._asks, *self._intents]
        near = closest(str(name), everything)
        return YeaError(
            "unknown_capability",
            f"no capability named {_json_str(name)}",
            fix=[fix(f"did you mean {near}?")] if near else [fix(f"send HELLO to list capabilities ({len(everything)} available)")],
        )

    @staticmethod
    def _params(frame: dict) -> dict:
        params = frame.get("params")
        if params is None:
            return {}
        if not isinstance(params, dict):
            raise YeaError("invalid_params", "`params` must be an object")
        return params

    @staticmethod
    def _verified_key(frame: dict) -> str | None:
        """The proof key of a request whose proof ``_authorize`` verified (it always verifies
        the proof when grants are present, and rejects the request otherwise)."""
        return frame["proof"]["key"] if frame.get("grants") else None

    def _consent(self, proposal: dict, principal: str | None) -> dict:
        return {
            "proposal": proposal["id"], "hash": proposal["hash"], "service": self.id,
            "capability": proposal["capability"], "principal": principal,
            "summary": proposal["summary"], "expires": proposal["expires"],
        }

    async def _authorize(
        self, frame: dict, verb: str, capability: str, target: str, proposal: dict | None = None,
        *, principal: str | None = None, replay: bool = False,
    ) -> Verification | None:
        """Verify grants and proof. ``principal``: only grants from this principal count (the
        one a proposal was made for). ``replay``: ``each``, ``total`` and risk were already checked by
        the original commit, so ``consent_required`` counts as authorized (§4.4)."""
        grants = frame.get("grants") or []
        required = verb in ("COMMIT", "UNDO") or self.require_grants
        if not grants:
            if required:
                raise YeaError(
                    "unauthorized",
                    f"{verb} needs a grant from your principal",
                    fix=[fix("ask your principal to issue a grant and send it in `grants` with a `proof`")],
                )
            return None
        if not isinstance(grants, list) or not all(isinstance(g, str) for g in grants):
            raise YeaError("bad_frame", "`grants` must be a list of strings")
        now = self.now()
        err = verify_proof(frame.get("proof"), self.id, verb, target, now)
        if err:
            raise YeaError(
                "unauthorized", err, fix=[fix(f'sign {{aud:"{self.id}",verb:"{verb}",target,ts}} with the grant holder key')]
            )
        ctx = GrantContext(
            self.id, verb, capability, now,
            _checked(proposal) if proposal else None,
            self._spent,
        )
        checks = []
        for g in grants:
            c = verify_grant(g, self.trust, frame["proof"]["key"], ctx)
            if principal and c.principal and c.principal != principal:
                checks.append(Verification(False, "forbidden", "grant is from a different principal than this proposal's", c.grant))
                continue
            if c.ok:
                return c
            if replay and c.code == "consent_required":
                return Verification(True, grant=c.grant)
            checks.append(c)
        if not required:
            return None  # a grant that doesn't apply to ASK/INTENT just means "anonymous"
        consent = next((c for c in checks if c.code == "consent_required"), None)
        if consent and proposal:
            raise YeaError(
                "consent_required",
                f"{consent.message}; your principal must approve this exact proposal",
                consent=self._consent(proposal, consent.principal),
            )
        forbidden = next((c for c in checks if c.code == "forbidden"), None)
        if forbidden:
            raise YeaError("forbidden", forbidden.message, need=forbidden.need)
        raise YeaError("unauthorized", checks[0].message)

    # ------------------------------------------------------------ verbs

    async def _on_ask(self, frame: dict, budget: int) -> dict:
        name = frame.get("capability")
        d = self._asks.get(name) if isinstance(name, str) else None
        if d is None:
            raise self._unknown_capability(name, "ask")
        params = self._params(frame)
        validate_params(d.params, params)
        auth = await self._authorize(frame, "ASK", name, name)
        data = await _call(d.run, Ctx(params, auth.principal if auth else None, agent=frame.get("agent")))
        return fit(self._frame(frame["id"], "ANSWER", {"data": data}), budget, self.handles, self._verified_key(frame))

    async def _on_intent(self, frame: dict, budget: int, emit: Emit) -> dict:
        name = frame.get("capability")
        d = self._intents.get(name) if isinstance(name, str) else None
        if d is None:
            raise self._unknown_capability(name, "intent")
        params = self._params(frame)
        validate_params(d.params, params)
        auto = frame.get("auto") is True
        auth = await self._authorize(frame, "INTENT", name, f"auto:{name}:{frame['id']}" if auto else name)
        # A repeated auto INTENT (same holder key + frame id) gets the original reply, never a
        # second commit (§4.3.1). Only proofs that _authorize verified are used as keys.
        key = f"{frame['proof']['key']}:{frame['id']}" if auto and frame.get("grants") else None
        if key:
            now = self.now()
            prior = self._auto_seen.get(key)
            if prior and prior[1] > now:
                r = await asyncio.shield(prior[0])
                return {**r, "id": random_id("s"), "re": frame["id"], **({"replay": True} if r["kind"] == "RECEIPT" else {})}
            task = asyncio.ensure_future(self._plan_intent(d, name, frame, params, budget, emit, auth, auto))
            # Outlive every proof that could carry this id: proofs are valid for 300s around ts.
            self._auto_seen[key] = (task, max(now, frame["proof"]["ts"]) + AUTO_MEMORY)
            if len(self._auto_seen) > 10_000:
                self._auto_seen = {k: v for k, v in self._auto_seen.items() if v[1] > now}
            return await asyncio.shield(task)
        return await self._plan_intent(d, name, frame, params, budget, emit, auth, auto)

    async def _plan_intent(
        self, d: _IntentDef, name: str, frame: dict, params: dict, budget: int, emit: Emit,
        auth: Verification | None, auto: bool,
    ) -> dict:
        try:
            principal = auth.principal if auth else None
            requester = self._verified_key(frame)
            goal = frame.get("goal") if isinstance(frame.get("goal"), str) else None
            out = await _call(d.plan, Ctx(params, principal, goal, frame.get("agent")))
            if isinstance(out, Clarification):
                return self._frame(frame["id"], "CLARIFY", {"question": out.question, "options": out.options})
            plans = list(out) if isinstance(out, (list, tuple)) else [out]
            if not plans:
                raise YeaError("not_found", "no way to satisfy this intent", fix=[fix("relax the constraints and try again")])
            now = self.now()
            proposals = []
            for plan in plans:
                window = (plan.undo_window or DAY) if plan.revert else None
                p: dict[str, Any] = {
                    "id": random_id("p"),
                    "capability": name,
                    "summary": plan.summary,
                    "effects": plan.effects,
                    "risk": plan.risk or d.risk or "low",
                    "undo": None if window is None else {"window": window},
                    "expires": -(-(now + (plan.expires_in or self.proposal_ttl)) // 60) * 60,  # whole minutes
                }
                uses = check_uses(plan.uses)
                if uses is not None:
                    p["uses"] = uses
                if plan.data is not _UNSET:
                    p["data"] = plan.data
                p["hash"] = proposal_hash(p)
                self._proposals[p["id"]] = _StoredProposal(p, plan, principal, requester)
                proposals.append(p)
            if auto:
                commit_auth = self._auto_auth(frame, proposals[0], principal)
                if commit_auth:
                    out = await self._execute(proposals[0]["id"], commit_auth, frame["id"], emit)
                    return fit({**out, "auto": True}, budget, self.handles, requester) if out["kind"] == "RECEIPT" else out
            return fit(self._frame(frame["id"], "PROPOSALS", {"proposals": proposals}), budget, self.handles, requester)
        except Exception as e:  # noqa: BLE001 — also reached from a cached auto task
            return self._error_reply(frame["id"], e)

    def _auto_auth(self, frame: dict, proposal: dict, principal: str | None) -> Verification | None:
        """A grant (from ``principal``, when set) that authorizes COMMIT of ``proposal``
        outright, if the proposal is undoable."""
        grants = frame.get("grants")
        if not proposal["undo"] or not grants:
            return None
        now = self.now()
        if verify_proof(frame.get("proof"), self.id, "INTENT", f"auto:{proposal['capability']}:{frame['id']}", now):
            return None
        ctx = GrantContext(self.id, "COMMIT", proposal["capability"], now,
                           _checked(proposal), self._spent)
        for g in grants:
            c = verify_grant(g, self.trust, frame["proof"]["key"], ctx)
            if c.ok and (principal is None or c.principal == principal):
                return c
        return None

    @staticmethod
    def _check_requester(stored: _StoredProposal, frame: dict) -> None:
        """Only the agent that asked for a proposal (with a verified proof) may commit it (§4.4)."""
        if stored.requester is None:
            raise YeaError("forbidden", "this proposal came from an anonymous INTENT and can't be committed",
                              fix=[fix("send INTENT again with your grant, then commit that proposal")])
        if stored.requester != frame["proof"]["key"]:
            raise YeaError("forbidden", "only the agent that requested this proposal can commit it",
                              fix=[fix("send INTENT yourself, then commit your own proposal")])

    async def _on_commit(self, frame: dict, budget: int, emit: Emit) -> dict:
        pid = frame.get("proposal")
        stored = self._proposals.get(pid) if isinstance(pid, str) else None
        if stored is None:
            raise YeaError("not_found", f"no proposal {_json_str(pid)}", fix=[fix("send INTENT again to get fresh proposals")])
        proposal = stored.proposal
        if frame.get("hash") != proposal["hash"]:
            # Never reveal the right hash: the agent must commit what it actually read.
            raise YeaError(
                "conflict",
                "hash does not match the proposal; you would commit something other than what you saw",
                fix=[fix("re-read the proposal, or send INTENT again")],
            )
        existing = self._commits.get(pid)
        if existing is not None:
            auth = await self._authorize(frame, "COMMIT", proposal["capability"], proposal["hash"], proposal,
                                         principal=stored.principal, replay=True)
            assert auth is not None
            self._check_requester(stored, frame)
            prior = await asyncio.shield(existing)
            if prior["kind"] == "RECEIPT" and self._receipts[prior["receipt"]["id"]].principal != auth.principal:
                raise YeaError("forbidden", "this proposal was committed by a different principal")
            return {**prior, "id": random_id("s"), "re": frame["id"], **({"replay": True} if prior["kind"] == "RECEIPT" else {})}
        auth = await self._authorize(frame, "COMMIT", proposal["capability"], proposal["hash"], proposal,
                                     principal=stored.principal)
        assert auth is not None
        self._check_requester(stored, frame)
        if self.now() >= proposal["expires"]:
            raise YeaError("expired", "this proposal has expired", fix=[fix("send INTENT again to get a fresh proposal")])
        out = await self._execute(pid, auth, frame["id"], emit)
        return fit(out, budget, self.handles, frame["proof"]["key"]) if out["kind"] == "RECEIPT" else out

    async def _execute(self, pid: str, auth: Verification, re: str, emit: Emit) -> dict:
        """Run a proposal's ``apply`` at most once; concurrent and later commits share the result.
        Spend is re-checked and reserved before anything can yield, and released on failure."""
        stored = self._proposals[pid]
        proposal, plan = stored.proposal, stored.plan
        held = self._reserve(proposal, auth)
        if held is None:
            return self._error_reply(re, YeaError(
                "consent_required",
                "would pass a total limit (other commits are in flight); your principal must approve this exact proposal",
                consent=self._consent(proposal, auth.principal),
            ))

        def progress(message: str, pct: float | None, data: Any) -> None:
            body: dict[str, Any] = {"message": message}
            if pct is not None:
                body["progress"] = pct
            if data is not None:
                body["data"] = data
            emit(self._frame(re, "EVENT", body))

        async def run() -> dict:
            try:
                result = await _call(plan.apply, CommitCtx(auth.principal, progress))
                at = self.now()
                receipt: dict[str, Any] = {
                    "id": random_id("r"), "proposal": pid, "capability": proposal["capability"], "summary": proposal["summary"],
                    "at": at, "effects": proposal["effects"],
                    "undo": {"until": at + proposal["undo"]["window"]} if proposal["undo"] else None,
                }
                if "uses" in proposal:
                    receipt["uses"] = proposal["uses"]
                if result is not None:
                    receipt["result"] = result
                self._receipts[receipt["id"]] = _StoredReceipt(receipt, plan, result, auth.principal)
                return self._frame(re, "RECEIPT", {"receipt": receipt})
            except Exception as e:  # noqa: BLE001
                for key, v in held:  # release the reservation
                    self._spent[key] -= v
                self._commits.pop(pid, None)  # failed commits may be retried
                return self._error_reply(re, e)

        task = asyncio.ensure_future(run())
        self._commits[pid] = task
        return await asyncio.shield(task)

    def _reserve(self, proposal: dict, auth: Verification) -> list[tuple[tuple[str, str], int]] | None:
        """Reserve the proposal's quantities against every ``total`` limit of the authorizing grant
        (§6.3), before anything can yield. None, reserving nothing, if one would pass its limit."""
        uses = proposal.get("uses") or {}
        held: dict[tuple[str, str], int] = {}
        for bid, limit in auth.total_limits():
            q = uses.get(limit["of"])
            if q is None or not same_unit(q, limit):
                continue  # not reported; a unit mismatch already failed the grant check
            key = (bid, limit["of"])
            held[key] = value(q)  # one reservation per (block, measure), however many limits name it
            if self._spent.get(key, 0) + held[key] > limit_value(limit):
                return None
        for key, v in held.items():
            self._spent[key] = self._spent.get(key, 0) + v
        return list(held.items())

    async def _on_undo(self, frame: dict, budget: int, emit: Emit) -> dict:
        rid = frame.get("receipt")
        stored = self._receipts.get(rid) if isinstance(rid, str) else None
        if stored is None or stored.receipt.get("undoes"):
            raise YeaError("not_found", f"no undoable receipt {_json_str(rid)}")
        auth = await self._authorize(frame, "UNDO", stored.receipt["capability"], rid)
        assert auth is not None
        if auth.principal != stored.principal:
            raise YeaError("forbidden", "only the principal who committed this can undo it")
        if stored.undone is not None:
            prior = await asyncio.shield(stored.undone)
            # Every waiter gets its own `re`, whether the shared attempt succeeded or failed.
            return {**prior, "id": random_id("s"), "re": frame["id"], **({"replay": True} if prior["kind"] == "RECEIPT" else {})}
        receipt, plan = stored.receipt, stored.plan
        if not receipt["undo"] or plan.revert is None:
            raise YeaError("forbidden", "this action is irreversible")
        if self.now() > receipt["undo"]["until"]:
            raise YeaError("expired", f"the undo window closed at {_iso(receipt['undo']['until'])}")
        re = frame["id"]

        def progress(message: str, pct: float | None, _data: Any) -> None:
            emit(self._frame(re, "EVENT", {"message": message, **({"progress": pct} if pct is not None else {})}))

        async def run() -> dict:
            try:
                await _call(plan.revert, CommitCtx(auth.principal, progress, stored.result))
                undo = {
                    "id": random_id("r"), "proposal": receipt["proposal"], "capability": receipt["capability"],
                    "summary": receipt["summary"], "at": self.now(), "effects": [_inverse(e) for e in receipt["effects"]],
                    "undo": None, "undoes": receipt["id"],
                }
                return self._frame(re, "RECEIPT", {"receipt": undo})
            except Exception as e:  # noqa: BLE001
                stored.undone = None
                return self._error_reply(re, e)

        stored.undone = asyncio.ensure_future(run())
        out = await asyncio.shield(stored.undone)
        return fit(out, budget, self.handles, frame["proof"]["key"]) if out["kind"] == "RECEIPT" else out

    def _on_expand(self, frame: dict, budget: int) -> dict:
        h = frame.get("handle")
        parked = self.handles.get(h) if isinstance(h, str) else None
        if parked is None:
            raise YeaError("expired", f"handle {_json_str(h)} is unknown or expired", fix=[fix("repeat the original request")])
        value, owner = parked
        if owner:  # handles from authenticated replies expand only for the same holder key (§4.6)
            proof = frame.get("proof")
            if verify_proof(proof, self.id, "EXPAND", h, self.now()) or proof["key"] != owner:
                raise YeaError("unauthorized", "this handle belongs to another agent",
                                  fix=[fix("expand it with the same key that made the original request")])
        elif self.require_grants:
            raise YeaError("unauthorized", "EXPAND needs a grant from your principal")
        data = {"items": value} if isinstance(value, list) else {"text": value}
        return fit(self._frame(frame["id"], "ANSWER", {"data": data}), budget, self.handles, owner)


def _json_str(v: Any) -> str:
    try:
        return compact(v)
    except TypeError:
        return repr(v)


def _iso(t: int) -> str:
    return datetime.fromtimestamp(t, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def service(id: str, name: str, summary: str = "", **kw: Any) -> Service:
    return Service(id, name, summary, **kw)
