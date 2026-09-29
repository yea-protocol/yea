"""Approval for job tools (docs/framework/SPEC-approval.md): the plan hash, the policy decision,
the approval form, the state that goes round the client, and how an answer is judged.

The decisions (plan hash, decide, the form, the state, judging) are synchronous and pure. The
store helpers (reservations, undo, consents, ``spent``) are async, and the key-file checks and
``choose_store`` touch the file system. The MCP side (``mcp-py``) drives it all; ``yea.store``
holds what must persist.

The entry of the ``yea.approval`` package: it re-exports the parts, each one job per module."""

from __future__ import annotations

from ..grants import RISK_ORDER  # re-exported: callers read the order from here
from ..risk import at_least  # re-exported: yea.risk's, which the decision and judge use
from .consent import (
    CONSENT_TTL,
    ConsentCheck,
    check_job_consent,
    consent_for,
    job_consent_code,
)
from .decision import Decision, decide, denied_reason, needs_approval
from .form import build_form, offered_plans
from .judge import Verdict, judge_answer
from .ledger import release_all, reserve_all, settle_all, spent
from .phrase import checked_phrase, normalize_phrase, phrase_matches, phrase_of
from .pinned_key import (
    _resolve_links,  # noqa: F401 — the key-file tests use it
    check_key_file,
    load_principal_key,
)
from .plan import HashedPlan, input_hash, plan_hash, plan_preimage
from .policy import (
    DEFAULT_OUT_OF_BAND,
    Policy,
    Tightening,
    load_policy,
    read_tightening,
)
from .state import MAX_ROUNDS, STATE_TTL, check_state, new_state
from .store_choice import choose_store
from .undo import UndoResult, new_receipt_id, undo_receipt

__all__ = [
    "RISK_ORDER",
    "plan_preimage",
    "plan_hash",
    "input_hash",
    "HashedPlan",
    "normalize_phrase",
    "checked_phrase",
    "phrase_of",
    "phrase_matches",
    "check_key_file",
    "load_principal_key",
    "DEFAULT_OUT_OF_BAND",
    "Tightening",
    "read_tightening",
    "Policy",
    "load_policy",
    "Decision",
    "at_least",
    "decide",
    "needs_approval",
    "denied_reason",
    "offered_plans",
    "build_form",
    "STATE_TTL",
    "MAX_ROUNDS",
    "new_state",
    "check_state",
    "Verdict",
    "judge_answer",
    "CONSENT_TTL",
    "job_consent_code",
    "consent_for",
    "ConsentCheck",
    "check_job_consent",
    "reserve_all",
    "spent",
    "settle_all",
    "release_all",
    "UndoResult",
    "undo_receipt",
    "new_receipt_id",
    "choose_store",
]
