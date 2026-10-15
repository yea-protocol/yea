"""Verifying a parsed request for its verb: find what it names (a capability, proposal, receipt or
handle), then check who sent it and whether they may act on that (SPEC §4, §6). Like
ts/src/service/verified-request/verbs.ts."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from ...errors import YeaError, fix
from ...grants import Verification
from ...keys import verify_proof
from ...validate import validate_params
from ..capabilities import unknown_capability
from ..state import ServiceState, _AskDef, _IntentDef, _StoredProposal, _StoredReceipt
from ..util import _json_str
from .identity import Identity, Scope, first_grant, identify, identify_required, with_limits


@dataclass(frozen=True)
class VerifiedHello:
    id: str
    budget: int


@dataclass(frozen=True)
class VerifiedAsk:
    id: str
    budget: int
    capability: str
    d: _AskDef
    params: dict
    holder: str | None
    principal: str | None


@dataclass(frozen=True)
class AutoCommit:
    """An auto INTENT (§4.3.1). ``replay``: the verified holder key and frame id, and the proof's
    ``ts``; None with no verified proof. ``grant(proposal)``: a grant that authorizes COMMIT of the
    proposal with no consent, if it is undoable; else None."""

    replay: tuple[str, int] | None
    grant: Callable[[dict], Verification | None]


@dataclass(frozen=True)
class VerifiedIntent:
    id: str
    budget: int
    capability: str
    d: _IntentDef
    params: dict
    goal: str | None
    holder: str | None
    principal: str | None
    auto: AutoCommit | None  # None unless the INTENT asked for auto-commit


@dataclass(frozen=True)
class VerifiedCommit:
    """A COMMIT from the proposal's requester, under a grant from its principal. ``limits()``: the
    grant that also admits the proposal's ``each``, ``total`` and ``risk``, or the error why none does."""

    id: str
    budget: int
    stored: _StoredProposal
    holder: str
    principal: str
    limits: Callable[[], Verification]


@dataclass(frozen=True)
class VerifiedUndo:
    """An UNDO under a grant from the principal who committed the receipt."""

    id: str
    budget: int
    stored: _StoredReceipt
    holder: str
    principal: str


@dataclass(frozen=True)
class VerifiedExpand:
    """An EXPAND by the key the handle was made for (``owner``), or of an anonymous reply's handle."""

    id: str
    budget: int
    value: Any
    owner: str | None


def verify_ask(state: ServiceState, req: dict, budget: int) -> VerifiedAsk:
    name, d = _lookup(state, state.asks, req["capability"], "ask")
    validate_params(d.params, req["params"])
    who = identify(state, req, Scope("ASK", name), name)
    return VerifiedAsk(req["id"], budget, name, d, req["params"], who.holder, who.principal)


def verify_intent(state: ServiceState, req: dict, budget: int) -> VerifiedIntent:
    name, d = _lookup(state, state.intents, req["capability"], "intent")
    validate_params(d.params, req["params"])
    target = f"auto:{name}:{req['id']}" if req["auto"] else name
    who = identify(state, req, Scope("INTENT", name), target)
    auto = _auto_commit(state, req, who) if req["auto"] else None
    return VerifiedIntent(req["id"], budget, name, d, req["params"], req["goal"], who.holder, who.principal, auto)


def _auto_commit(state: ServiceState, req: dict, who: Identity) -> AutoCommit:
    """The auto-commit check of an INTENT whose identity was verified against the auto target. Only
    that proof's key is ever a replay key: an unverified one would let anyone claim a replay."""

    def grant(proposal: dict) -> Verification | None:
        if not proposal["undo"] or who.holder is None:
            return None
        # Only a grant from the proposal's principal counts, so the search goes on past a valid
        # grant from another one.
        scope = Scope("COMMIT", proposal["capability"], proposal, who.principal)
        return first_grant(state, req["grants"], who.holder, scope, limits=True)[0]

    replay = (f"{who.proof['key']}:{req['id']}", who.proof["ts"]) if who.proof else None
    return AutoCommit(replay, grant)


def verify_commit(state: ServiceState, req: dict, budget: int) -> VerifiedCommit:
    pid = req["proposal"]
    stored = state.proposals.get(pid) if pid is not None else None
    if stored is None:
        raise YeaError("not_found", f"no proposal {_json_str(pid)}", fix=[fix("send INTENT again to get fresh proposals")])
    proposal = stored.proposal
    if req["hash"] != proposal["hash"]:
        # Never reveal the right hash: the agent must commit what it actually read.
        raise YeaError(
            "conflict",
            "hash does not match the proposal; you would commit something other than what you saw",
            fix=[fix("re-read the proposal, or send INTENT again")],
        )
    scope = Scope("COMMIT", proposal["capability"], proposal, stored.principal)
    holder, principal, _ = identify_required(state, req, scope, proposal["hash"])
    _check_requester(stored, holder)
    return VerifiedCommit(req["id"], budget, stored, holder, principal, lambda: with_limits(state, req["grants"], holder, scope))


def _check_requester(stored: _StoredProposal, holder: str) -> None:
    """Only the agent that asked for a proposal (with a verified proof) may commit it (§4.4)."""
    if stored.requester is None:
        raise YeaError("forbidden", "this proposal came from an anonymous INTENT and can't be committed",
                       fix=[fix("send INTENT again with your grant, then commit that proposal")])
    if stored.requester != holder:
        raise YeaError("forbidden", "only the agent that requested this proposal can commit it",
                       fix=[fix("send INTENT yourself, then commit your own proposal")])


def verify_undo(state: ServiceState, req: dict, budget: int) -> VerifiedUndo:
    rid = req["receipt"]
    stored = state.receipts.get(rid) if rid is not None else None
    if stored is None or rid is None or stored.receipt.get("undoes"):
        raise YeaError("not_found", f"no undoable receipt {_json_str(rid)}")
    holder, principal, _ = identify_required(state, req, Scope("UNDO", stored.receipt["capability"]), rid)
    # §4.5: only a grant rooted in the principal of the original commit may undo it.
    if principal != stored.principal:
        raise YeaError("forbidden", "only the principal who committed this can undo it")
    return VerifiedUndo(req["id"], budget, stored, holder, principal)


def verify_expand(state: ServiceState, req: dict, budget: int) -> VerifiedExpand:
    """Handles from authenticated replies expand only for the same holder key (§4.6)."""
    h = req["handle"]
    parked = state.handles.get(h) if h is not None else None
    if parked is None or h is None:
        raise YeaError("expired", f"handle {_json_str(h)} is unknown or expired", fix=[fix("repeat the original request")])
    value, owner = parked
    if owner:
        proof = req["proof"]
        if verify_proof(proof, state.id, "EXPAND", h, state.now()) or proof is None or proof["key"] != owner:
            raise YeaError("unauthorized", "this handle belongs to another agent",
                           fix=[fix("expand it with the same key that made the original request")])
    elif state.require_grants:
        raise YeaError("unauthorized", "EXPAND needs a grant from your principal")
    return VerifiedExpand(req["id"], budget, value, owner)


def _lookup(state: ServiceState, defs: dict, name: str | None, kind: str) -> tuple[str, Any]:
    """The capability a request names, registered under ``defs``; raises ``unknown_capability`` otherwise."""
    d = defs.get(name) if name is not None else None
    if name is None or d is None:
        raise unknown_capability(state, name, kind)
    return name, d
