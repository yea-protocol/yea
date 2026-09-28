"""The person's policy: the signed grant plus unsigned tightening (SPEC-approval §2)."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from ..grants import RISK_ORDER, Grant, block_id, decode_grant
from ..uses import is_limit, limit_value

DEFAULT_OUT_OF_BAND = "high"


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
        return Tightening(warnings=("the policy file is not a JSON object; ignored",))
    warnings = [f'ignored "{k}": unknown field' for k in doc if k not in ("deny", "outOfBand")]
    deny: tuple[str, ...] = ()
    if "deny" in doc:
        if isinstance(doc["deny"], list) and all(isinstance(t, str) for t in doc["deny"]):
            deny = tuple(doc["deny"])
        else:
            warnings.append('ignored "deny": bad value')
    oob = DEFAULT_OUT_OF_BAND
    if "outOfBand" in doc:
        if doc["outOfBand"] in RISK_ORDER:
            oob = doc["outOfBand"]
        else:
            warnings.append('ignored "outOfBand": bad value')
    return Tightening(deny, oob, tuple(warnings))


@dataclass(frozen=True)
class Policy:
    """The person's standing rules: a verified signed grant (or none) plus unsigned tightenings.
    Without a grant nothing runs without asking, but ``deny`` and ``out_of_band`` still apply."""

    grant: Grant | str | None = None
    principal: str | None = None
    server_key: str | None = None
    deny: tuple[str, ...] = ()
    out_of_band: str = DEFAULT_OUT_OF_BAND
    totals: tuple[tuple[str, dict], ...] = field(default=())  # (block id, limit), one per block and measure


def load_policy(grant: str | Grant | None, server_key: str, principal_key: str | None, tightening: Tightening) -> Policy:
    """The policy for this server: the signed grant as given (it is verified on every decision,
    as a COMMIT of the tool at service id = the server key, issued to the server key by the
    pinned principal) plus the unsigned tightenings."""
    base = {"deny": tightening.deny, "out_of_band": tightening.out_of_band, "server_key": server_key,
            "principal": principal_key}
    if grant is None:
        return Policy(**base)
    g: Grant | str = grant
    if isinstance(grant, str):
        try:
            g = decode_grant(grant)
        except ValueError:
            pass  # kept as text: the grant check refuses it with its reason
    totals = _smallest_totals(g) if isinstance(g, Grant) else ()
    return Policy(**base, grant=g, totals=totals)


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
