"""What handlers work with: the request contexts, a Plan and its effects, and clarify (SPEC §4.3, §5.1)."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

_UNSET: Any = object()


@dataclass
class Ctx:
    """Passed to ``run`` and ``plan``."""

    params: dict
    principal: str | None  # the principal behind a valid grant, if the agent presented one
    goal: str | None = None
    agent: dict | None = None


@dataclass
class CommitCtx:
    """Passed to ``Plan.apply`` and ``Plan.revert`` (which also gets ``result``)."""

    principal: str
    _emit: Callable[[str, float | None, Any], None]
    result: Any = None

    def progress(self, message: str, progress: float | None = None, data: Any = None) -> None:
        """Stream progress to the agent as an EVENT frame."""
        self._emit(message, progress, data)


@dataclass
class Plan:
    """One way to satisfy an intent. Becomes a proposal; ``apply`` runs only on COMMIT."""

    summary: str
    effects: list[dict]
    apply: Callable[[CommitCtx], Any]
    uses: dict | None = None  # SPEC §5.1, e.g. {"spend": spend("22.87", "USD"), "emails": quantity(1)}
    risk: str | None = None
    expires_in: int | None = None  # seconds; default is the service's proposal_ttl
    data: Any = _UNSET
    revert: Callable[[CommitCtx], Any] | None = None  # makes the proposal undoable
    undo_window: int | None = None  # seconds; default one day when revert is set


@dataclass
class Clarification:
    question: str
    options: list[dict]  # [{"label": str, "params": mergePatch}]


def clarify(question: str, options: list[dict]) -> Clarification:
    """Return from ``plan`` when the intent is ambiguous (SPEC §4.3)."""
    return Clarification(question, options)


# Effect helpers (SPEC §5.1).
def _effect(op: str, target: str, detail: str | None, **kw: Any) -> dict:
    e = {"op": op, "target": target, **kw}
    if detail:
        e["detail"] = detail
    return e


def create(target: str, detail: str | None = None) -> dict:
    return _effect("create", target, detail)


def update(target: str, field: str, from_: Any, to: Any, detail: str | None = None) -> dict:
    return _effect("update", target, detail, field=field, **{"from": from_, "to": to})


def remove(target: str, detail: str | None = None) -> dict:
    return _effect("delete", target, detail)


def send(target: str, detail: str | None = None) -> dict:
    return _effect("send", target, detail)
