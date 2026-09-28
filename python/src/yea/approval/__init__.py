"""Approval for job tools (docs/framework/SPEC-approval.md): the plan hash, the policy decision,
the approval form, the state that goes round the client, and how an answer is judged.

The decisions (plan hash, decide, the form, the state, judging) are synchronous and pure. The
store helpers (reservations, undo, consents, ``spent``) are async, and the key-file checks and
``choose_store`` touch the file system. The MCP side (``mcp-py``) drives it all; ``store.py``
holds what must persist.

The entry of the ``yea.approval`` package: it re-exports the parts, each one job per module."""

from __future__ import annotations

from ..grants import RISK_ORDER  # re-exported: callers read the order from here
from .plan import plan_preimage, plan_hash, input_hash, HashedPlan
from .phrase import normalize_phrase, phrase_of, phrase_matches
from .key_file import check_key_file, load_principal_key, _resolve_links
from .policy import DEFAULT_OUT_OF_BAND, Tightening, read_tightening, Policy, load_policy
from .decide import Decision, at_least, decide, needs_approval, denied_reason
from .form import offered_plans, build_form
from .state import STATE_TTL, MAX_ROUNDS, new_state, BAD_STATE, check_state
from .judge import Verdict, judge_answer
from .consent import CONSENT_TTL, job_consent_code, consent_for, ConsentCheck, check_job_consent
from .ledger import reserve_all, spent, settle_all, release_all
from .undo import UndoResult, undo_receipt, new_receipt_id
from .store_choice import choose_store

__all__ = [
    "RISK_ORDER",
    "plan_preimage",
    "plan_hash",
    "input_hash",
    "HashedPlan",
    "normalize_phrase",
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
    "BAD_STATE",
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
