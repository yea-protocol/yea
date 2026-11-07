"""What a service remembers: its registered capabilities, and the commit ledger that keeps every
proposal's life (like ts/src/service/state.ts)."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field

from ..budget import HandleStore
from ..grants import Trusted
from .commit_ledger import CommitLedger


@dataclass
class _AskDef:
    summary: str
    params: dict | None
    run: Callable


@dataclass
class _IntentDef:
    summary: str
    params: dict | None
    risk: str | None
    plan: Callable


@dataclass
class ServiceState:
    """One per Service: every verb's handler takes this same state (ts/src/service/state.ts)."""

    id: str
    trust: Trusted
    require_grants: bool
    proposal_ttl: int
    handles: HandleStore
    clock: Callable[[], float]
    asks: dict[str, _AskDef] = field(default_factory=dict)
    intents: dict[str, _IntentDef] = field(default_factory=dict)
    # Every proposal's life, and the usage ledger its `total` limits count against.
    ledger: CommitLedger = field(init=False)

    def __post_init__(self) -> None:
        self.ledger = CommitLedger(self.id, self.now)

    def now(self) -> int:
        return int(self.clock())
