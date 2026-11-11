"""Verifying a grant chain against a request: signatures, holders, trust and every caveat (SPEC §6.4)."""

from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass, field
from typing import Any

from .._json import CanonicalError, canonical_bytes
from ..keys import parse_public_key, verify
from ..uses import limit_value
from .caveats import BlockFacts, caveat_denial
from .context import GrantContext
from .periods import TotalLimit, anchor_of, end_of, ledger_key
from .token import Grant, block_id, decode_grant

Trusted = Iterable[str] | Callable[[str], bool]


@dataclass
class Verification:
    ok: bool
    code: str | None = None  # unauthorized | forbidden | consent_required
    message: str = ""
    grant: Grant | None = None
    failed: list[dict] = field(default_factory=list)  # caveats that were not satisfied
    reason: str = ""  # the same words as the TypeScript core's check
    # For a COMMIT it authorizes, with the limits: each ``total`` it counts against, in the
    # period worked out from the check's clock, which the reservation then uses (SPEC §6.3).
    totals: list[TotalLimit] = field(default_factory=list)

    @property
    def need(self) -> list[dict] | None:
        """For ``forbidden``: the caveats a grant would need to drop (SPEC §7 ``need``)."""
        return (self.failed or None) if self.code == "forbidden" else None  # none to drop: no need, as TS

    @property
    def principal(self) -> str | None:
        return self.grant.principal if self.grant else None



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

    end = end_of(g.blocks)
    denials = [
        (c, d)
        for b in g.blocks
        for c in b["p"]["caveats"]
        if (d := caveat_denial(c, block_id(b), ctx, BlockFacts(anchor_of(b), end)))
    ]
    if not ctx.limits:  # only the limits deny softly: who may act is decided by the hard denials
        denials = [(c, d) for c, d in denials if d.hard]
    if not denials:
        return Verification(True, grant=g, totals=_totals(g, ctx))
    hard = [(c, d) for c, d in denials if d.hard]
    if hard:
        shown = ", ".join(d.why for _, d in hard[:3])
        return Verification(False, "forbidden", f"the grant does not allow this request ({shown})", g, [c for c, _ in hard],
                            reason="; ".join(d.why for _, d in hard))
    shown = ", ".join(d.why for _, d in denials[:3])
    return Verification(False, "consent_required", f"the proposal exceeds the grant's limits ({shown})", g,
                        [c for c, _ in denials], reason="; ".join(d.why for _, d in denials))


def _totals(g: Grant, ctx: GrantContext) -> list[TotalLimit]:
    """The ``total`` limits a COMMIT counts against, each at its ledger key at ``ctx.now``. None
    outside COMMIT, or when the limits aren't checked."""
    if ctx.verb != "COMMIT" or not ctx.limits:
        return []
    out = []
    for b in g.blocks:
        for c in b["p"]["caveats"]:
            key = ledger_key(block_id(b), c["total"], anchor_of(b), ctx.now) if "total" in c else None
            if key:
                out.append(TotalLimit(key, limit_value(c["total"])))
    return out
