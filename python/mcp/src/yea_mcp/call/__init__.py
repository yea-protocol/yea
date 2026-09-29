"""How a job call runs (SPEC-mcp-py, "How a call runs", steps 1–11). Every decision comes from the
SDK core (``decide``, ``build_form``, ``judge_answer``, ``consent_for``); this package only orders
them and turns their answers into MCP results. The job wrapper and the guard middleware share it.

The entry of the ``yea_mcp.call`` package: it re-exports the parts, each one job per module."""

from __future__ import annotations

from .model import (
    BAD_STATE,
    Call,
    JobDef,
    PartialApplyError,
    Req,
    Result,
    Yea,
    _maybe,  # noqa: F401 — yea_mcp uses it for the undo tool and the job wrapper
    is_partial,
)
from .prepare import (
    caller_of,
    described_plans,
    described_risk,
    hash_plans,
    is_memory_store,
    policy_for,
)
from .route import run_job
from .run import json_safe

__all__ = [
    "PartialApplyError",
    "is_partial",
    "Result",
    "BAD_STATE",
    "Yea",
    "JobDef",
    "Req",
    "Call",
    "is_memory_store",
    "caller_of",
    "policy_for",
    "hash_plans",
    "described_risk",
    "described_plans",
    "run_job",
    "json_safe",
]
