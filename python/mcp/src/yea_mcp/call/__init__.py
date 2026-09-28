"""How a job call runs (SPEC-mcp-py, "How a call runs", steps 1–11). Every decision comes from the
SDK core (``decide``, ``build_form``, ``judge_answer``, ``consent_for``); this package only orders
them and turns their answers into MCP results. The job wrapper and the guard middleware share it.

The entry of the ``yea_mcp.call`` package: it re-exports the parts, each one job per module."""

from __future__ import annotations

from .model import (
    BAD_STATE,
    NOTHING_RAN,
    Call,
    JobDef,
    Req,
    Result,
    Yea,
    _maybe,  # noqa: F401 — yea_mcp uses it for the undo tool
    wire_failed,
    wire_with_note,
    wire_with_receipt,
)
from .prepare import caller_of, described_risk, hash_plans, is_memory_store, policy_for
from .route import run_job
from .run import json_safe

__all__ = [
    "Result",
    "NOTHING_RAN",
    "BAD_STATE",
    "Yea",
    "wire_failed",
    "wire_with_receipt",
    "wire_with_note",
    "JobDef",
    "Req",
    "Call",
    "is_memory_store",
    "caller_of",
    "policy_for",
    "hash_plans",
    "described_risk",
    "run_job",
    "json_safe",
]
