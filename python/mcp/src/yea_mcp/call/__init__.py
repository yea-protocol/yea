"""How a job call runs (SPEC-mcp-py, "How a call runs"). The SDK's job call session
(``yea.job_call``) decides every round and owns the order that keeps it safe; this package is its
adapter: it reads the request, turns each outcome into an MCP result, and applies the chosen plan.
The job wrapper and the guard middleware share it.

The entry of the ``yea_mcp.call`` package: it re-exports the parts, each one job per module."""

from __future__ import annotations

from .model import (
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
    policy_for,
)
from .route import run_job
from .run import json_safe

__all__ = [
    "PartialApplyError",
    "is_partial",
    "Result",
    "Yea",
    "JobDef",
    "Req",
    "Call",
    "caller_of",
    "policy_for",
    "described_risk",
    "described_plans",
    "run_job",
    "json_safe",
]
