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
from .keys import parse_public_key
from .lens import effect_line, fmt_duration
from .store import ApprovalStore, FileStore, LedgerKey, MemoryStore, Reservation, is_receipt_id
from .uses import check_uses, fmt_uses, is_limit, limit_value, same_unit, value

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
    try:
        return sha256_b64url(canonical(input).encode("utf-8"))
    except CanonicalError as e:
        raise ValueError(f"a job tool's input may hold only integer numbers ({e}); use a string or an integer instead") from None


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


def phrase_of(p: HashedPlan, phrase_for: Callable[[HashedPlan], str] | None) -> str:
    """The phrase for ``p``: the tool's, or ``approve`` when it names none. A phrase that is
    empty once normalized would let an empty field approve, so it becomes ``approve`` too."""
    phrase = phrase_for(p) if phrase_for is not None else None
    return phrase if isinstance(phrase, str) and normalize_phrase(phrase) else "approve"


def phrase_matches(typed: Any, phrase: str) -> bool:
    return isinstance(typed, str) and normalize_phrase(typed) == normalize_phrase(phrase)


# ------------------------------------------------------------------ §2 policy


def check_key_file(path: str | os.PathLike[str]) -> str | None:
    """Why the pinned principal key file can't be trusted, or None. It is refused if the file, any
    symlink on the way to it, or any directory above one of them is owned by, or writable by,
    this process's user: any of those would let an agent running as it swap in its own key."""
    try:
        visited, real = _resolve_links(Path(os.path.abspath(path)))
        if not stat.S_ISREG(real.stat().st_mode):
            return f"the principal key file {path} isn't a regular file"
    except OSError as e:
        return f"can't read the principal key file {path}: {e.strerror or e}"
    for q in dict.fromkeys(x for v in (*visited, real) for x in (v, *v.parents)):
        why = _reachable(q)
        if why:
            return why
    return None


def load_principal_key(path: str | os.PathLike[str]) -> str:
    """The pinned principal public key, read only after ``check_key_file`` passes. Once the whole
    chain is out of this user's reach it can't be swapped, and the opened file is checked again
    with ``fstat``. Raises ValueError with the reason when the key can't be trusted."""
    why = check_key_file(path)
    if why:
        raise ValueError(why)
    _, real = _resolve_links(Path(os.path.abspath(path)))
    fd = os.open(real, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    with os.fdopen(fd, encoding="utf-8") as f:
        st = os.fstat(f.fileno())
        if st.st_uid == os.geteuid() or st.st_mode & (stat.S_IWOTH | stat.S_IWGRP) and _in_group(st.st_gid, st.st_mode):
            raise ValueError(f"{real} changed while it was being read")
        key = f.read().strip()
    parse_public_key(key)
    return key


def _in_group(gid: int, mode: int) -> bool:
    return bool(mode & stat.S_IWOTH) or gid == os.getegid() or gid in os.getgroups()


def _resolve_links(p: Path, hops: int = 0) -> tuple[list[Path], Path]:
    """Resolve ``p`` one symlink at a time. Returns every path visited (links included) and the
    real path it ends at. Each step starts from an already-real directory."""
    visited: list[Path] = []
    cur, rest = Path(p.anchor), list(p.parts[1:])
    while rest:
        part = rest.pop(0)
        if part in ("", "."):
            continue
        if part == "..":
            cur = cur.parent
            continue
        nxt = cur / part
        visited.append(nxt)
        if not nxt.is_symlink():
            cur = nxt
            continue
        hops += 1
        if hops > 40:
            raise OSError(40, "too many levels of symbolic links", str(p))
        target = Path(os.readlink(nxt))
        if target.is_absolute():
            cur = Path(target.anchor)
        rest = list(target.parts[1:] if target.is_absolute() else target.parts) + rest
    return visited, cur


def _reachable(q: Path) -> str | None:
    st = q.lstat()
    if st.st_uid == os.geteuid():
        return f"{q} is owned by this server's user, so an agent running as it could change the principal key"
    if stat.S_ISLNK(st.st_mode):
        return None  # a link's own mode means nothing; its directory and its target are checked
    if _writable(q, st):
        return f"{q} is writable by this server's user, so an agent running as it could change the principal key"
    return None


def _writable(q: Path, st: os.stat_result) -> bool:
    effective = os.access in os.supports_effective_ids
    return os.access(q, os.W_OK, effective_ids=effective) or bool(st.st_mode & stat.S_IWOTH)


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


def load_policy(grant: str | Grant | None, server_key: str, principal_key: str | None, tightening: Tightening,
                now: int) -> Policy:
    """Verify the signed policy grant as a COMMIT at this server (service id = the server key),
    issued to the server key by the pinned principal. A grant that fails is treated as none."""
    base = {"deny": tightening.deny, "out_of_band": tightening.out_of_band, "server_key": server_key}
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
            if isinstance(c, dict) and len(c) == 1 and is_limit(c.get("total")):
                lim = c["total"]  # a malformed one is skipped here; the grant check refuses it
                key = (bid, lim.get("of"))
                if key not in best or limit_value(lim) < limit_value(best[key]):
                    best[key] = lim
    return tuple((bid, lim) for (bid, _), lim in best.items())


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


def decide(plans: list[HashedPlan], policy: Policy, used: Callable[[LedgerKey], int], now: int) -> Decision:
    """What a job call should do with these plans under this policy, at ``now`` (a policy loaded
    earlier still expires on time). Only ``plans[0]`` can run."""
    if not plans:
        return Decision("nothing")
    first = plans[0]
    if first.tool in policy.deny:
        return Decision("denied", denied_reason(first.tool))
    if at_least(first.risk, policy.out_of_band):
        return Decision("out-of-band", f"risk is {first.risk}, which needs approval outside the chat")
    why = needs_approval(first, policy, used, now)
    if why is not None:
        return Decision("ask", why)
    return Decision("run", plan=first, reserve=_reservations(first, policy))


def needs_approval(p: HashedPlan, policy: Policy, used: Callable[[LedgerKey], int], now: int) -> str | None:
    """Why ``p`` can't run without asking, or None (§2's conditions, in the pinned order)."""
    if not p.undoable:
        return f"{p.tool} can't be undone"
    if policy.grant is None or policy.server_key is None or policy.principal is None:
        return f"no signed policy lets {p.tool} run without asking"
    uses = check_uses(p.plan.uses)
    proposal: dict[str, Any] = {"hash": p.plan_hash, "risk": p.risk, **({"uses": uses} if uses is not None else {})}
    spent = {(bid, lim["of"]): used(LedgerKey(bid, lim["of"])) for bid, lim in policy.totals}
    if not _names_tools(policy.grant):
        return f"the signed policy names no tools, so it doesn't let {p.tool} run without asking"
    ctx = GrantContext(policy.server_key, "COMMIT", p.tool, now, proposal, spent)
    v = verify_grant(policy.grant, [policy.principal], policy.server_key, ctx)
    return None if v.ok else v.message


def _names_tools(g: Grant) -> bool:
    """§2 condition 1 needs a ``can`` that covers the tool: a grant with no ``can`` at all
    (which the protocol reads as "any capability") doesn't auto-run job tools."""
    return any(isinstance(c, dict) and "can" in c for b in g.blocks for c in b["p"]["caveats"])


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


def build_form(plans: list[HashedPlan], why: str, policy: Policy, phrase_for: Callable[[HashedPlan], str]) -> dict | None:
    """``{message, requested_schema, offered}`` for a form-mode elicitation (§3). Plans that are
    denied or at or above ``out_of_band`` are described but can't be chosen here. None when no
    plan can be chosen: the caller fails closed with consent codes instead of asking."""
    offered = offered_plans(plans, policy)
    if not offered:
        return None
    lines = [f"Approval needed: {why}.", ""]
    for i, p in enumerate(plans, 1):
        lines.extend(_plan_lines(i, p))
        if p in offered:
            lines.append(f"  to approve, type: {phrase_of(p, phrase_for)}")
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
        confirm = {"type": "string", "title": "Confirm", "description": f'Type "{phrase_of(offered[0], phrase_for)}" to approve.'}
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
    phrase = phrase_of(chosen, phrase_for)
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


# ------------------------------------------------------------------ §6 consents from `yea approve`


async def consent_for(plans: list[HashedPlan], store: ApprovalStore, policy: Policy, now: int) -> HashedPlan | None:
    """The first recomputed plan with a valid, unused consent from ``yea approve``, consuming it.

    A consent counts only if it is a grant signed by the pinned principal, issued to this
    server's key, for a COMMIT of that tool at this server, bound to that plan hash by an
    ``only`` caveat, and not expired. A policy grant copied into the consents folder has no
    ``only`` and never counts. Denied tools are never run."""
    if policy.principal is None or policy.server_key is None:
        return None
    for p in plans:
        if p.tool in policy.deny:
            continue
        token = await store.get_consent(p.plan_hash)
        g = _valid_consent(token, p, policy, now) if token else None
        if g is not None and await store.consume_once(g.id, _expiry(g)):
            return p
    return None


def _valid_consent(token: str, p: HashedPlan, policy: Policy, now: int) -> Grant | None:
    try:
        g = decode_grant(token.strip())
    except ValueError:
        return None
    caveats = [c for b in g.blocks for c in b["p"]["caveats"]]
    if {"only": p.plan_hash} not in caveats or _expiry(g) is None:
        return None
    uses = check_uses(p.plan.uses)
    proposal: dict[str, Any] = {"hash": p.plan_hash, "risk": p.risk, **({"uses": uses} if uses is not None else {})}
    ctx = GrantContext(policy.server_key or "", "COMMIT", p.tool, now, proposal)
    ok = verify_grant(g, [policy.principal or ""], policy.server_key or "", ctx).ok
    return g if ok else None


def _expiry(g: Grant) -> Any:
    """The earliest ``exp`` in the grant; consents must have one, which bounds a replay."""
    exps = [c["exp"] for b in g.blocks for c in b["p"]["caveats"] if isinstance(c, dict) and type(c.get("exp")) is int]
    return min(exps) if exps else None
