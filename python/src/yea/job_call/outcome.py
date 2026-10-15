"""What a job call session works with, and what each of its rounds returns."""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, field
from typing import Any

from ..approval import HashedPlan, Policy
from ..service import Clarification
from ..store import ApprovalStore, Reservation


@dataclass(frozen=True)
class JobTool:
    """The job tool being called, as the session needs it. With ``revert``, a plan with an
    ``undo_window`` can be undone; ``confirm_with`` gives the phrase the person types for a plan
    (``approve`` when it's absent or empty)."""

    name: str
    risk: str | None = None
    revert: Callable[..., Any] | None = None
    confirm_with: Callable[[HashedPlan, dict], Any] | None = None


@dataclass(frozen=True)
class JobCall:
    """One round of a job call: its facts, read afresh on every round. ``plan`` is the tool's
    handler, which runs on every round and on preview, so it must change nothing. ``unpinned`` says
    why no principal key is pinned, when ``policy.principal`` is empty: no consent counts then."""

    tool: JobTool
    input: dict
    plan: Callable[[], Awaitable[Any]]
    sub: str
    now: int
    policy: Policy
    can_ask: bool
    preview: bool = False
    unpinned: str | None = None


@dataclass(frozen=True)
class Retry:
    """A retry: the state the last round handed out, as it came back, and the person's answer."""

    state: Any
    answer: Mapping[str, Any]


@dataclass(frozen=True)
class Outcome:
    """How a round ends, by ``kind``:

    - ``clarify``: the handler's question (``clarification``), to return as it is;
    - ``preview``: the ``plans`` to show; nothing ran or was stored;
    - ``run``: apply ``plan`` once (``how``: ``auto`` or ``approved``), then settle ``held``, or
      release it if ``apply()`` fails;
    - ``ask``: ask the person with ``form``, carrying ``state`` round the client. If the client
      turns out to be unreachable, ``otherwise()`` is what to return instead;
    - ``consent-codes``: nothing runs; ``plans`` with ``codes`` to approve outside the chat, or
      ``unavailable`` saying why no consent can be accepted here;
    - ``refuse``: nothing runs, and ``why``. ``again`` means a new call asks afresh."""

    kind: str
    why: str | None = None
    plans: list[HashedPlan] = field(default_factory=list)
    plan: HashedPlan | None = None
    how: str | None = None
    held: list[Reservation] = field(default_factory=list)
    form: dict | None = None
    state: dict | None = None
    otherwise: Callable[[], Outcome] | None = None
    codes: list[dict] = field(default_factory=list)
    unavailable: str | None = None
    clarification: Clarification | None = None
    again: bool = False


@dataclass(frozen=True)
class Round:
    """A round in progress: the call, its hashed plans, its store, and the phrase for each plan."""

    call: JobCall
    plans: list[HashedPlan]
    store: ApprovalStore
    phrase_for: Callable[[HashedPlan], str]
