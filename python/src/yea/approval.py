"""Approval for job tools (docs/framework/SPEC-approval.md): the plan hash, the policy decision,
the approval form, the state that goes round the client, and how an answer is judged.

Everything here is synchronous and pure except ``check_key_file``, which reads the file system.
The MCP side (``mcp-py``) drives it; ``store.py`` holds what must persist."""

from __future__ import annotations

import os
import secrets
import stat
import unicodedata
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ._json import CanonicalError, b64url_encode, canonical, sha256_b64url
from .grants import RISK_ORDER, Grant, GrantContext, block_id, consent_code, decode_grant, verify_grant
from .lens import effect_line, fmt_duration
from .store import ApprovalStore, FileStore, LedgerKey, MemoryStore, Reservation, is_receipt_id
from .uses import check_uses, fmt_uses, limit_value, same_unit, value

STATE_TTL = 600  # seconds; no later than the MCP SDK's own request-state lifetime
CONSENT_TTL = 600
MAX_ROUNDS = 3
DEFAULT_OUT_OF_BAND = "high"
_STRIP = "\u0009\u000a\u000b\u000c\u000d  ﻿"


# ------------------------------------------------------------------ §1 plan hash


def plan_preimage(tool: str, input: Any, plan: Any, risk: str) -> dict:
    """``{tool, input, summary, effects, uses, risk, undoWindow}``, absent optional fields left out."""
    pre: dict[str, Any] = {"tool": tool, "input": input, "summary": plan.summary, "effects": plan.effects}
    uses = check_uses(plan.uses)
    if uses is not None:
        pre["uses"] = uses
    pre["risk"] = risk
    if plan.undo_window is not None:
        pre["undoWindow"] = plan.undo_window
    return pre


def plan_hash(tool: str, input: Any, plan: Any, risk: str) -> str:
    """``b64url(sha256(canonical(preimage)))``. Raises ValueError when the input holds a number
    that isn't an integer, since canonical JSON has none."""
    try:
        return sha256_b64url(canonical(plan_preimage(tool, input, plan, risk)).encode("utf-8"))
    except CanonicalError as e:
        raise ValueError(
            f"{tool}: a job tool's input and plans may hold only integer numbers ({e}); use a string or an integer instead"
        ) from None


def input_hash(input: Any) -> str:
    return sha256_b64url(canonical(input).encode("utf-8"))


@dataclass(frozen=True)
class HashedPlan:
    """A plan with what approval needs: its tool, its hash, its resolved risk, and whether it
    can be undone (it has an undo window and the tool has ``revert``)."""

    tool: str
    plan: Any
    plan_hash: str
    risk: str
    undoable: bool


# ------------------------------------------------------------------ §3 phrases


def normalize_phrase(s: str) -> str:
    """NFC, then strip exactly U+0009–000D, U+0020, U+00A0, U+FEFF at both ends, then lowercase."""
    return unicodedata.normalize("NFC", s).strip(_STRIP).lower()


def phrase_matches(typed: Any, phrase: str) -> bool:
    return isinstance(typed, str) and normalize_phrase(typed) == normalize_phrase(phrase)


# ------------------------------------------------------------------ §2 policy


def check_key_file(path: str | os.PathLike[str]) -> str | None:
    """Why the pinned principal key file can't be trusted, or None. It is refused if the file or
    any directory above it is owned by, or writable by, this process's user. Both the path as
    given and the path its symlinks lead to are checked, since a link in a writable directory
    can be swapped too."""
    given = Path(os.path.abspath(path))
    try:
        real = given.resolve(strict=True)
    except OSError as e:
        return f"can't read the principal key file {path}: {e.strerror or e}"
    for q in dict.fromkeys((given, *given.parents, real, *real.parents)):
        why = _reachable(q)
        if why:
            return why
    return None


def _reachable(q: Path) -> str | None:
    st = q.lstat()
    if st.st_uid == os.geteuid():
        return f"{q} is owned by this server's user, so an agent running as it could change the principal key"
    if stat.S_ISLNK(st.st_mode):
        return None  # a link's own mode means nothing; its directory and its target are checked
    if os.access(q, os.W_OK) or st.st_mode & stat.S_IWOTH:
        return f"{q} is writable by this server's user, so an agent running as it could change the principal key"
    return None


@dataclass(frozen=True)
class Tightening:
    deny: tuple[str, ...] = ()
    out_of_band: str = DEFAULT_OUT_OF_BAND
    warnings: tuple[str, ...] = ()


def read_tightening(doc: Any) -> Tightening:
    """The unsigned policy (server options or ``~/.yea/policy.json``). It can only tighten:
    anything unknown or loosening is ignored with a warning, and the valid rules still apply."""
    if doc is None:
        return Tightening()
    if not isinstance(doc, dict):
        return Tightening(warnings=("ignored the unsigned policy: it isn't a JSON object",))
    warnings = [f"ignored unknown field {k!r} in the unsigned policy" for k in doc if k not in ("deny", "outOfBand")]
    deny: tuple[str, ...] = ()
    if "deny" in doc:
        if isinstance(doc["deny"], list) and all(isinstance(t, str) for t in doc["deny"]):
            deny = tuple(doc["deny"])
        else:
            warnings.append("ignored deny: it must be a list of tool names")
    oob = DEFAULT_OUT_OF_BAND
    if "outOfBand" in doc:
        if doc["outOfBand"] in RISK_ORDER:
            oob = doc["outOfBand"]
        else:
            warnings.append("ignored outOfBand: it must be low, medium or high")
    return Tightening(deny, oob, tuple(warnings))


@dataclass(frozen=True)
class Policy:
    """The person's standing rules: a verified signed grant (or none) plus unsigned tightenings.
    Without a grant nothing runs without asking, but ``deny`` and ``out_of_band`` still apply."""

    grant: Grant | None = None
    principal: str | None = None
    server_key: str | None = None
    deny: tuple[str, ...] = ()
    out_of_band: str = DEFAULT_OUT_OF_BAND
    totals: tuple[tuple[str, dict], ...] = field(default=())  # (block id, limit), one per block and measure
    problem: str | None = None  # why a grant that was given wasn't accepted (for logs)
    now: int = 0  # when the policy was loaded; grants are checked as of then


def load_policy(grant: str | Grant | None, server_key: str, principal_key: str | None, tightening: Tightening,
                now: int) -> Policy:
    """Verify the signed policy grant as a COMMIT at this server (service id = the server key),
    issued to the server key by the pinned principal. A grant that fails is treated as none."""
    base = {"deny": tightening.deny, "out_of_band": tightening.out_of_band, "server_key": server_key, "now": now}
    if grant is None:
        return Policy(**base, problem="there's no signed policy")
    if principal_key is None:
        return Policy(**base, problem="the principal key isn't pinned")
    try:
        g = grant if isinstance(grant, Grant) else decode_grant(grant)
    except ValueError as e:
        return Policy(**base, problem=f"the signed policy is malformed: {e}")
    probe = verify_grant(g, [principal_key], server_key, GrantContext(server_key, "INTENT", None, now))
    if probe.code == "unauthorized":
        return Policy(**base, problem=f"the signed policy doesn't verify: {probe.message}")
    return Policy(**base, grant=g, principal=principal_key, totals=_smallest_totals(g))


def _smallest_totals(g: Grant) -> tuple[tuple[str, dict], ...]:
    """One ``total`` per block and measure; when a block repeats one, the smallest max applies."""
    best: dict[tuple[str, str], dict] = {}
    for b in g.blocks:
        bid = block_id(b)
        for c in b["p"]["caveats"]:
            if isinstance(c, dict) and len(c) == 1 and isinstance(c.get("total"), dict):
                lim = c["total"]
                key = (bid, lim.get("of"))
                if key not in best or _limit_value(lim) < _limit_value(best[key]):
                    best[key] = lim
    return tuple((bid, lim) for (bid, _), lim in best.items())


def _limit_value(lim: dict) -> int:
    try:
        return limit_value(lim)
    except (KeyError, TypeError):
        return -1  # malformed: the grant check refuses it anyway


# ------------------------------------------------------------------ decide


@dataclass(frozen=True)
class Decision:
    """``nothing`` | ``denied`` | ``out-of-band`` | ``ask`` | ``run``."""

    kind: str
    why: str | None = None
    plan: HashedPlan | None = None
    reserve: tuple[tuple[LedgerKey, int, int], ...] = ()  # (key, amount, max) to reserve before apply


def at_least(risk: str, level: str) -> bool:
    return RISK_ORDER.get(risk, RISK_ORDER["high"]) >= RISK_ORDER[level]


def decide(plans: list[HashedPlan], policy: Policy, used: Callable[[LedgerKey], int]) -> Decision:
    """What a job call should do with these plans under this policy. Only ``plans[0]`` can run."""
    if not plans:
        return Decision("nothing")
    first = plans[0]
    if first.tool in policy.deny:
        return Decision("denied", denied_reason(first.tool))
    if at_least(first.risk, policy.out_of_band):
        return Decision("out-of-band", f"risk is {first.risk}, which needs approval outside the chat")
    why = needs_approval(first, policy, used)
    if why is not None:
        return Decision("ask", why)
    return Decision("run", plan=first, reserve=_reservations(first, policy))


def needs_approval(p: HashedPlan, policy: Policy, used: Callable[[LedgerKey], int]) -> str | None:
    """Why ``p`` can't run without asking, or None (§2's conditions, in the pinned order)."""
    if not p.undoable:
        return f"{p.tool} can't be undone"
    if policy.grant is None or policy.server_key is None or policy.principal is None:
        return f"no signed policy lets {p.tool} run without asking"
    uses = check_uses(p.plan.uses)
    proposal: dict[str, Any] = {"hash": p.plan_hash, "risk": p.risk, **({"uses": uses} if uses is not None else {})}
    spent = {(bid, lim["of"]): used(LedgerKey(bid, lim["of"])) for bid, lim in policy.totals}
    ctx = GrantContext(policy.server_key, "COMMIT", p.tool, policy.now, proposal, spent)
    v = verify_grant(policy.grant, [policy.principal], policy.server_key, ctx)
    return None if v.ok else v.message


def denied_reason(tool: str) -> str:
    return f"your policy never allows {tool}"


def _reservations(p: HashedPlan, policy: Policy) -> tuple[tuple[LedgerKey, int, int], ...]:
    uses = check_uses(p.plan.uses) or {}
    out = []
    for bid, lim in policy.totals:
        q = uses.get(lim["of"])
        if q is not None and same_unit(q, lim):
            out.append((LedgerKey(bid, lim["of"]), value(q), limit_value(lim)))
    return tuple(out)


# ------------------------------------------------------------------ §3 the form


def offered_plans(plans: list[HashedPlan], policy: Policy) -> list[HashedPlan]:
    """The plans the form may offer: not denied, and below ``out_of_band``."""
    return [p for p in plans if p.tool not in policy.deny and not at_least(p.risk, policy.out_of_band)]


def build_form(plans: list[HashedPlan], why: str, policy: Policy, phrase_for: Callable[[HashedPlan], str]) -> dict:
    """``{message, requested_schema, offered}`` for a form-mode elicitation (§3). Plans that are
    denied or at or above ``out_of_band`` are described but can't be chosen here."""
    offered = offered_plans(plans, policy)
    lines = [f"Approval needed: {why}.", ""]
    for i, p in enumerate(plans, 1):
        lines.extend(_plan_lines(i, p))
        if p in offered:
            lines.append(f"  to approve, type: {phrase_for(p)}")
    held = [f"[{i}]" for i, p in enumerate(plans, 1) if p not in offered]
    if held:
        lines.append(f"Not offered here (approve outside the chat): {', '.join(held)}")
    return {"message": "\n".join(lines), "requested_schema": _schema(offered, phrase_for), "offered": [p.plan_hash for p in offered]}


def _plan_lines(n: int, p: HashedPlan) -> list[str]:
    attrs = []
    if (u := fmt_uses(check_uses(p.plan.uses) or {})) is not None:
        attrs.append(f"uses: {u}")
    attrs.append(f"risk: {p.risk}")
    attrs.append(f"undo: {fmt_duration(p.plan.undo_window)}" if p.undoable else "undo: never")
    return [f"[{n}] {p.plan.summary}", *("  " + effect_line(e) for e in p.plan.effects), "  " + " · ".join(attrs)]


def _schema(offered: list[HashedPlan], phrase_for: Callable[[HashedPlan], str]) -> dict:
    if len(offered) == 1:
        confirm = {"type": "string", "title": "Confirm", "description": f'Type "{phrase_for(offered[0])}" to approve.'}
        return {"type": "object", "properties": {"confirm": confirm}, "required": ["confirm"]}
    plan = {"type": "string", "title": "Plan", "oneOf": [{"const": p.plan_hash, "title": p.plan.summary} for p in offered]}
    confirm = {"type": "string", "title": "Confirm", "description": "Type the phrase shown for the plan you chose."}
    return {"type": "object", "properties": {"plan": plan, "confirm": confirm}, "required": ["plan", "confirm"]}


# ------------------------------------------------------------------ §4 state


def new_state(tool: str, input_hash: str, sub: str, plans: list[str], round: int, now: int) -> dict:
    """The requestState plaintext: hashes, a counter and a nonce only."""
    return {"v": 1, "tool": tool, "inputHash": input_hash, "sub": sub, "plans": list(plans),
            "round": round, "nonce": b64url_encode(secrets.token_bytes(16)), "exp": now + STATE_TTL}


BAD_STATE = "this approval is invalid or has expired; call the tool again"


def check_state(state: Any, tool: str, input_hash: str, sub: str, now: int) -> dict | None:
    """The state if it can be used for this call, else None. Callers refuse every failure with
    the same message (``BAD_STATE``)."""
    ok = (
        isinstance(state, dict) and state.get("v") == 1 and state.get("tool") == tool
        and state.get("inputHash") == input_hash and state.get("sub") == sub
        and isinstance(state.get("plans"), list) and all(isinstance(h, str) for h in state["plans"])
        and type(state.get("round")) is int and 1 <= state["round"] <= MAX_ROUNDS
        and isinstance(state.get("nonce"), str) and type(state.get("exp")) is int and now < state["exp"]
    )
    return state if ok else None


# ------------------------------------------------------------------ §5 judging the answer


@dataclass(frozen=True)
class Verdict:
    """``refuse`` | ``not-approved`` | ``ask-again`` | ``denied`` | ``out-of-band`` | ``run``."""

    kind: str
    why: str | None = None
    round: int | None = None
    plan: HashedPlan | None = None


def judge_answer(state: dict, answer: Mapping[str, Any], recomputed: list[HashedPlan], policy: Policy,
                 phrase_for: Callable[[HashedPlan], str]) -> Verdict:
    """Steps 3–7 of §5, after the state was verified and its nonce consumed."""
    if answer.get("action") != "accept":
        return Verdict("not-approved", "not approved")
    content = answer.get("content") if isinstance(answer.get("content"), dict) else {}
    pick = _picked(state, content)
    if pick is None:
        return Verdict("refuse", "that plan was not offered")
    chosen = next((p for p in recomputed if p.plan_hash == pick), None)
    if chosen is None:
        return _again(state, "the plans changed; choose again")
    if chosen.tool in policy.deny:
        return Verdict("denied", denied_reason(chosen.tool))
    if at_least(chosen.risk, policy.out_of_band):
        return Verdict("out-of-band", plan=chosen)
    phrase = phrase_for(chosen)
    if not phrase_matches(content.get("confirm"), phrase):
        return _again(state, f'type "{phrase}" exactly to approve')
    return Verdict("run", plan=chosen)


def _picked(state: dict, content: Mapping[str, Any]) -> str | None:
    """The chosen plan hash, if it was one of the offered ones. With one offered plan the form
    has no ``plan`` field, so that one is chosen."""
    offered = state["plans"]
    pick = content.get("plan", offered[0] if len(offered) == 1 else None)
    return pick if isinstance(pick, str) and pick in offered else None


def _again(state: dict, why: str) -> Verdict:
    if state["round"] + 1 > MAX_ROUNDS:
        return Verdict("refuse", f"not approved after {MAX_ROUNDS} tries")
    return Verdict("ask-again", why, state["round"] + 1)


# ------------------------------------------------------------------ §6 consent codes


def job_consent_code(server_key: str, principal: str, tool: str, input: Any, plan: Any, plan_hash_: str,
                     risk: str, now: int) -> str:
    """The unsigned ``pc1.`` consent request for one plan, carrying the plan-hash preimage."""
    consent = {"proposal": plan_hash_, "hash": plan_hash_, "service": server_key, "capability": tool,
               "principal": principal, "summary": plan.summary, "expires": now + CONSENT_TTL}
    return consent_code(consent, plan_preimage(tool, input, plan, risk))


# ------------------------------------------------------------------ §5 reservations, §7 undo, §8 store choice


async def reserve_all(store: ApprovalStore, wanted: tuple[tuple[LedgerKey, int, int], ...]) -> list[Reservation] | None:
    """Reserve every (key, amount, max) or none: if one would pass its limit, release the ones
    already made and return None, so the call asks instead of running."""
    held: list[Reservation] = []
    try:
        for key, amount, mx in wanted:
            r = await store.reserve(key, amount, mx)
            if r is None:
                await release_all(store, held)
                return None
            held.append(r)
    except BaseException:
        await release_all(store, held)
        raise
    return held


async def settle_all(store: ApprovalStore, held: list[Reservation]) -> None:
    for r in held:
        await store.settle(r)


async def release_all(store: ApprovalStore, held: list[Reservation]) -> None:
    for r in held:
        await store.release(r)


@dataclass(frozen=True)
class UndoResult:
    """``undone`` | ``not-found`` | ``refused`` (with why)."""

    kind: str
    why: str | None = None
    receipt: dict | None = None


async def undo_receipt(store: ApprovalStore, receipt_id: Any, sub: str, now: int,
                       revert: Callable[[dict], Any]) -> UndoResult:
    """§7: check the id's format, then the window and principal, then claim, revert, and mark
    done (or release the claim if revert fails, so it can be tried again). ``revert`` gets
    ``{input, planHash, result}`` and may be async."""
    if not is_receipt_id(receipt_id):
        return UndoResult("not-found", f"no receipt {receipt_id!r}")
    r = await store.get_receipt(receipt_id)
    if r is None or r.get("sub") != sub:
        return UndoResult("not-found", f"no receipt {receipt_id!r}")
    undo = r.get("undo")
    if not isinstance(undo, dict) or not isinstance(undo.get("until"), int):
        return UndoResult("refused", "undo: never; this action can't be undone")
    if now > undo["until"]:
        return UndoResult("refused", "the undo window has closed")
    if not await store.claim_undo(receipt_id):
        return UndoResult("refused", "this action was already undone")
    try:
        out = revert({"input": r.get("input"), "planHash": r.get("planHash"), "result": r.get("result")})
        if hasattr(out, "__await__"):
            await out
    except BaseException:
        await store.release_undo(receipt_id)
        raise
    await store.mark_undone(receipt_id)
    return UndoResult("undone", receipt=r)


def choose_store(http: bool, store: ApprovalStore | None, policy: Policy, single_process: bool = False) -> ApprovalStore:
    """§8: stdio defaults to FileStore; HTTP to MemoryStore, which it refuses when the policy has
    a ``total`` limit unless the author passes a store or says the server is one process."""
    if store is not None:
        return store
    if not http:
        return FileStore()
    if policy.totals and not single_process:
        raise ValueError("an HTTP server with a total limit needs a shared store: pass store=…, or single_process=True")
    return MemoryStore()


def new_receipt_id() -> str:
    """``r_`` and 12 b64url characters (9 random bytes)."""
    return "r_" + b64url_encode(secrets.token_bytes(9))
