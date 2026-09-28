"""Grants: attenuable Ed25519 delegation chains (SPEC §6.2–6.4)."""

from __future__ import annotations

import os
import time
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass, field
from typing import Any

from ._json import CanonicalError, b64url_decode, b64url_encode, canonical_bytes, compact, loads, proposal_hash, sha256_b64url
from .keys import KeyPair, parse_public_key, verify
from .uses import fmt_quantity, is_limit, is_uses, limit_value, same_unit, value

TOKEN_PREFIX = "pg1."
RISK_ORDER = {"low": 0, "medium": 1, "high": 2}
# Caveats that, when they are the only ones failing a COMMIT, mean "ask the human" (§6.6).
CONSENT_CAVEATS = frozenset({"risk", "each", "total"})
LIMITS = frozenset({"each", "total"})
COMMIT_ONLY = frozenset({"each", "total", "risk", "only"})

Trusted = Iterable[str] | Callable[[str], bool]


def block_id(block: Mapping[str, Any]) -> str:
    """``b64url(sha256(utf8(block.s)))``."""
    return sha256_b64url(block["s"].encode("utf-8"))


@dataclass(frozen=True)
class Grant:
    blocks: tuple[dict, ...]

    @property
    def id(self) -> str:
        return block_id(self.blocks[0])

    @property
    def block_ids(self) -> list[str]:
        return [block_id(b) for b in self.blocks]

    @property
    def principal(self) -> str:
        return self.blocks[0]["p"]["iss"]

    @property
    def holder(self) -> str:
        return self.blocks[-1]["p"]["sub"]

    def encode(self) -> str:
        return TOKEN_PREFIX + b64url_encode(canonical_bytes(list(self.blocks)))

    def delegate(self, holder: KeyPair, sub: str, caveats: list[dict], iat: int | None = None) -> Grant:
        """Append a block handing a narrower grant to ``sub``. ``holder`` must be the current holder."""
        if holder.public != self.holder:
            raise ValueError("only the grant's holder can delegate it")
        payload = {
            "prev": block_id(self.blocks[-1]),
            "sub": sub,
            "caveats": list(caveats),
            "iat": int(time.time()) if iat is None else iat,
        }
        return Grant(self.blocks + ({"p": payload, "s": holder.sign(canonical_bytes(payload))},))

    def __str__(self) -> str:
        return self.encode()


def issue_grant(
    issuer: KeyPair, sub: str, caveats: list[dict], iat: int | None = None, nonce: str | None = None
) -> Grant:
    """Issue a root grant from principal ``issuer`` to holder key ``sub``."""
    payload = {
        "iss": issuer.public,
        "sub": sub,
        "caveats": list(caveats),
        "iat": int(time.time()) if iat is None else iat,
        "nonce": b64url_encode(os.urandom(12)) if nonce is None else nonce,
    }
    return Grant(({"p": payload, "s": issuer.sign(canonical_bytes(payload))},))


def delegate_grant(grant: Grant | str, holder: KeyPair, sub: str, caveats: list[dict], iat: int | None = None) -> Grant:
    g = decode_grant(grant) if isinstance(grant, str) else grant
    return g.delegate(holder, sub, caveats, iat)


def consent_grant(principal: KeyPair, agent_key: str, consent: Mapping[str, Any]) -> Grant:
    """The grant a principal signs to approve one ``consent_required`` proposal (§6.6).

    It authorizes exactly one thing: COMMIT of that proposal hash, for that capability, at
    that service, until the proposal expires. Run this in the principal's own tool; an agent
    must never be able to trigger signing with the principal key."""
    return issue_grant(principal, agent_key, [
        {"svc": [consent["service"]]},
        {"verbs": ["COMMIT"]},
        {"can": [consent["capability"]]},
        {"only": consent["hash"]},
        {"exp": consent["expires"]},
    ])


CONSENT_PREFIX = "pc1."
_CONSENT_STR_FIELDS = ("proposal", "hash", "service", "capability", "principal", "summary")


def consent_code(consent: Mapping[str, Any], detail: Mapping[str, Any] | None = None, agent: str | None = None) -> str:
    """Encode a consent request for out-of-band approval: ``pc1.`` + b64url(canonical(c)).

    Pass the proposal the agent received as ``detail`` (``data`` is dropped) so the
    approver can show its real effects and re-check the hash (SPEC §6.6). ``agent`` is the
    key the consent should be issued to, for approving on a machine without that agent's
    key; it is unsigned, so the approver shows it and checks it against a local agent key."""
    body = dict(consent)
    if detail is not None:
        body["detail"] = {k: v for k, v in detail.items() if k != "data"}
    if agent is not None:
        body["agent"] = agent
    return CONSENT_PREFIX + b64url_encode(canonical_bytes(body))


def check_consent(consent: Mapping[str, Any], proposal: Mapping[str, Any], service: str) -> None:
    """What an approver's tooling MUST check before showing a consent request (SPEC §6.6):
    it names the proposal the agent actually received, from that service, and that
    proposal's content hashes to the approved hash. Raises ValueError on any mismatch."""
    if consent.get("service") != service:
        raise ValueError("consent request names a different service")
    for field_, want in (("proposal", proposal.get("id")), ("hash", proposal.get("hash")), ("capability", proposal.get("capability"))):
        if consent.get(field_) != want:
            raise ValueError(f"consent request {field_} does not match the proposal")
    if proposal_hash(proposal) != consent["hash"]:
        raise ValueError("the proposal's content does not hash to the approved hash")


def decode_consent_code(code: str) -> dict:
    """Decode and validate a ``pc1.`` consent code. Raises ValueError."""
    if not isinstance(code, str) or not code.startswith(CONSENT_PREFIX):
        raise ValueError("not a consent code (expected pc1.…)")
    try:
        c = loads(b64url_decode(code[len(CONSENT_PREFIX):]).decode("utf-8"))
    except (ValueError, UnicodeDecodeError) as e:
        raise ValueError(f"consent code is not valid b64url JSON: {e}") from None
    if not isinstance(c, dict):
        raise ValueError("a consent code encodes an object")
    for k in _CONSENT_STR_FIELDS:
        if not isinstance(c.get(k), str):
            raise ValueError(f"consent code missing {k}")
    if not _safe_int(c.get("expires")):
        raise ValueError("consent code missing expires")
    return c


def _is_int(v: Any) -> bool:
    return type(v) is int


def decode_grant(token: str) -> Grant:
    """Decode and structurally validate a token. Does not check signatures. Raises ValueError."""
    if not isinstance(token, str) or not token.startswith(TOKEN_PREFIX):
        raise ValueError("not a pg1 grant")
    try:
        blocks = loads(b64url_decode(token[len(TOKEN_PREFIX):]).decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        raise ValueError("not valid b64url JSON") from None
    if not isinstance(blocks, list) or not blocks:
        raise ValueError("grant has no blocks")
    for i, b in enumerate(blocks):
        if not isinstance(b, dict) or not isinstance(b.get("p"), dict) or not isinstance(b.get("s"), str):
            raise ValueError("malformed block")
        p = b["p"]
        need = ("iss", "sub", "nonce") if i == 0 else ("prev", "sub")
        if not all(isinstance(p.get(k), str) for k in need):
            raise ValueError("malformed block")
        if not isinstance(p.get("caveats"), list) or not _is_int(p.get("iat")):
            raise ValueError("malformed block")
    return Grant(tuple(blocks))


@dataclass
class GrantContext:
    """What a request asks for, evaluated against caveats."""

    service: str
    verb: str
    capability: str | None
    now: int
    proposal: Mapping[str, Any] | None = None  # {hash, uses?, risk}; COMMIT only
    # (block id, measure name) -> value committed or reserved, as an integer at scale 18
    used: Mapping[tuple[str, str], int] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> GrantContext:
        return cls(d["service"], d["verb"], d.get("capability"), d["now"], d.get("proposal"), _used(d.get("used")))


def _used(d: Any) -> dict[tuple[str, str], int]:
    """``{block id: {measure: quantity}}`` (the JSON form) as exact values keyed by (block id, measure)."""
    if not isinstance(d, dict):
        return {}
    return {(bid, of): value(q) for bid, per in d.items() if isinstance(per, dict) for of, q in per.items()}


@dataclass
class Verification:
    ok: bool
    code: str | None = None  # unauthorized | forbidden | consent_required
    message: str = ""
    grant: Grant | None = None
    failed: list[dict] = field(default_factory=list)  # caveats that were not satisfied
    reason: str = ""  # the same words as the TypeScript core's check (pinned by conformance)

    @property
    def need(self) -> list[dict] | None:
        """For ``forbidden``: the caveats a grant would need to drop (SPEC §7 ``need``)."""
        return self.failed if self.code == "forbidden" else None

    @property
    def principal(self) -> str | None:
        return self.grant.principal if self.grant else None

    def total_limits(self) -> list[tuple[str, dict]]:
        """(block id, limit) for every ``total`` caveat in the grant."""
        out = []
        if self.grant:
            for b in self.grant.blocks:
                for c in b["p"]["caveats"]:
                    if isinstance(c, dict) and "total" in c:
                        out.append((block_id(b), c["total"]))
        return out


def _matches(pattern: Any, name: str) -> bool:
    if not isinstance(pattern, str):
        return False
    if pattern.endswith("*"):
        return name.startswith(pattern[:-1])
    return pattern == name


@dataclass(frozen=True)
class Denial:
    """Why a caveat failed. ``hard`` means refuse (``forbidden``); otherwise ask (``consent_required``)."""

    why: str
    hard: bool


def limit_denial(name: str, limit: Mapping[str, Any], proposal: Mapping[str, Any], already: int = 0) -> Denial | None:
    """Why an ``each`` or ``total`` limit fails for a proposal, or None if it holds. A present
    but malformed ``uses`` (including null) is hard. ``already`` is the exact value committed
    or reserved under the block (``total`` only)."""
    if "uses" not in proposal:
        return None
    uses = proposal["uses"]
    if not is_uses(uses):
        return Denial("malformed uses on the proposal", hard=True)
    of = limit["of"]
    q = uses.get(of)
    if q is None:
        return None  # limits bind only what is reported
    if not same_unit(q, limit):
        return Denial(f"{of} is in {q.get('unit') or 'no unit'}, but the limit is in {limit.get('unit') or 'no unit'}", hard=False)
    shown = fmt_quantity({"amount": limit["max"], **{k: limit[k] for k in ("scale", "unit") if k in limit}})
    if name == "each" and value(q) > limit_value(limit):
        return Denial(f"{of} over the per-commit limit of {shown}", hard=False)
    if name == "total" and already + value(q) > limit_value(limit):
        return Denial(f"{of} would pass the total limit of {shown}", hard=False)
    return None


def _safe_int(v: Any) -> bool:
    return _is_int(v) and abs(v) <= 2**53 - 1


def _str_list(v: Any) -> bool:
    return isinstance(v, list) and all(isinstance(x, str) for x in v)


_WELL_FORMED = {
    "svc": _str_list, "verbs": _str_list, "can": _str_list,
    "exp": _safe_int, "nbf": _safe_int,
    "each": is_limit, "total": is_limit,
    "risk": lambda v: isinstance(v, str) and v in RISK_ORDER,
    "only": lambda v: isinstance(v, str),
}


def well_formed(caveat: Any) -> bool:
    """A known caveat name with a value of the right shape (SPEC §6.3)."""
    if not isinstance(caveat, dict) or len(caveat) != 1:
        return False
    (name, arg), = caveat.items()
    check = _WELL_FORMED.get(name)
    return check is not None and check(arg)


def check_caveat(caveat: Any, bid: str, ctx: GrantContext) -> bool:
    """True iff one caveat is satisfied. Unknown or malformed caveats fail closed."""
    return caveat_denial(caveat, bid, ctx) is None


def caveat_denial(caveat: Any, bid: str, ctx: GrantContext) -> Denial | None:
    """Why one caveat fails, or None when it is satisfied. Unknown or malformed caveats fail hard."""
    if not isinstance(caveat, dict) or len(caveat) != 1 or next(iter(caveat)) not in _WELL_FORMED:
        kind = "malformed" if not isinstance(caveat, dict) else "unknown"
        return Denial(f"{kind} caveat {compact(caveat)}", hard=True)
    if not well_formed(caveat):
        return Denial(f"malformed caveat {compact(caveat)}", hard=True)
    (name, arg), = caveat.items()
    if name in COMMIT_ONLY and ctx.verb != "COMMIT":
        return None  # known, and ignored outside COMMIT (§6.3)
    if name in LIMITS:
        return limit_denial(name, arg, ctx.proposal or {}, int(ctx.used.get((bid, arg["of"]), 0)))
    why = _denial(name, arg, ctx)
    return Denial(why, hard=name not in CONSENT_CAVEATS) if why else None


def _denial(name: str, arg: Any, ctx: GrantContext) -> str | None:
    """Why a well-formed, non-limit caveat denies the request, or None."""
    prop = ctx.proposal or {}
    if name == "svc":
        return None if ctx.service in arg else f"not valid for service {ctx.service}"
    if name == "verbs":
        return None if ctx.verb in arg else f"does not allow {ctx.verb}"
    if name == "can":
        ok = ctx.capability is not None and any(_matches(p, ctx.capability) for p in arg)
        return None if ok else f"does not cover {ctx.capability}"
    if name == "exp":
        return None if ctx.now < arg else "grant has expired"
    if name == "nbf":
        return None if ctx.now >= arg else "grant is not valid yet"
    if name == "risk":
        risk = prop.get("risk")
        return f"risk {risk} exceeds ceiling {arg}" if RISK_ORDER.get(risk, 3) > RISK_ORDER[arg] else None
    if name == "only":
        return None if prop.get("hash") == arg else "grant is bound to a different proposal"
    return f"unknown caveat {compact({name: arg})}"


def _trusts(trusted: Trusted, key: str) -> bool:
    return trusted(key) if callable(trusted) else key in set(trusted)


def verify_grant(
    token: str | Grant, trusted: Trusted, proof_key: str, ctx: GrantContext | Mapping[str, Any]
) -> Verification:
    """Verify one grant for one request (SPEC §6.4). Never raises."""
    if not isinstance(ctx, GrantContext):
        ctx = GrantContext.from_dict(ctx)
    try:
        g = token if isinstance(token, Grant) else decode_grant(token)
    except ValueError as e:
        return Verification(False, "unauthorized", str(e), reason=f"malformed grant: {e}")

    for i, b in enumerate(g.blocks):
        p = b["p"]
        signer = p["iss"] if i == 0 else g.blocks[i - 1]["p"]["sub"]
        if i > 0 and p["prev"] != block_id(g.blocks[i - 1]):
            return Verification(False, "unauthorized", f"block {i} does not chain to block {i - 1}", g,
                                reason=f"block {i} is not chained to block {i - 1}")
        try:
            parse_public_key(p["sub"])
            msg = canonical_bytes(p)
        except (ValueError, CanonicalError) as e:
            return Verification(False, "unauthorized", f"block {i} is malformed: {e}", g, reason=f"malformed grant: {e}")
        if not verify(signer, msg, b["s"]):
            return Verification(False, "unauthorized", f"block {i} signature does not verify", g,
                                reason=f"bad signature on block {i}")

    if not _trusts(trusted, g.principal):
        return Verification(False, "unauthorized", "the grant's principal is not trusted by this service", g,
                            reason="grant is issued by a principal this service does not trust")
    if g.holder != proof_key:
        return Verification(False, "unauthorized", "the proof key is not the grant's holder", g,
                            reason="proof key is not the grant holder")

    denials = [(c, d) for b in g.blocks for c in b["p"]["caveats"] if (d := caveat_denial(c, block_id(b), ctx))]
    if not denials:
        return Verification(True, grant=g)
    hard = [(c, d) for c, d in denials if d.hard]
    if hard:
        shown = ", ".join(d.why for _, d in hard[:3])
        return Verification(False, "forbidden", f"the grant does not allow this request ({shown})", g, [c for c, _ in hard],
                            reason="; ".join(d.why for _, d in hard))
    shown = ", ".join(d.why for _, d in denials[:3])
    return Verification(False, "consent_required", f"the proposal exceeds the grant's limits ({shown})", g,
                        [c for c, _ in denials], reason="; ".join(d.why for _, d in denials))
