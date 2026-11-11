"""Grants: attenuable Ed25519 delegation chains (SPEC §6.2–6.4), and the periods a ``total``
with ``every`` counts in (§6.3).

The entry of the ``yea.grants`` package: it re-exports the parts, each one job per module."""

from __future__ import annotations

from .caveats import (
    COMMIT_ONLY,
    CONSENT_CAVEATS,
    LIMITS,
    RISK_ORDER,
    BlockFacts,
    Denial,
    caveat_denial,
    check_caveat,
    limit_denial,
    well_formed,
)
from .consent import CONSENT_PREFIX, consent_code, consent_expiry, consent_grant, decode_consent_code, matches_consent
from .context import GrantContext
from .periods import LedgerKey, Period, TotalLimit, fmt_limit, total_keys
from .token import (
    TOKEN_PREFIX,
    Grant,
    block_id,
    decode_grant,
    delegate_grant,
    issue_grant,
)
from .verify import Trusted, Verification, verify_grant

__all__ = [
    "TOKEN_PREFIX",
    "block_id",
    "Grant",
    "issue_grant",
    "delegate_grant",
    "decode_grant",
    "consent_grant",
    "CONSENT_PREFIX",
    "consent_code",
    "consent_expiry",
    "decode_consent_code",
    "matches_consent",
    "RISK_ORDER",
    "CONSENT_CAVEATS",
    "LIMITS",
    "COMMIT_ONLY",
    "BlockFacts",
    "Denial",
    "limit_denial",
    "well_formed",
    "check_caveat",
    "caveat_denial",
    "Trusted",
    "Verification",
    "verify_grant",
    "GrantContext",
    "LedgerKey",
    "Period",
    "TotalLimit",
    "fmt_limit",
    "total_keys",
]
