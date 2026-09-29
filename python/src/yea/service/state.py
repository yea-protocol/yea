"""What a service remembers: registered capabilities, the proposals it made and the receipts it gave (like
ts/src/service/state.ts)."""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from ..budget import HandleStore
from ..grants import Trusted
from .plan import Plan


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
class _StoredProposal:
    proposal: dict
    plan: Plan
    principal: str | None  # the principal whose grant authorized the INTENT, if any
    requester: str | None  # the holder key whose verified proof was on the INTENT (§4.4)


@dataclass
class _StoredReceipt:
    receipt: dict
    plan: Plan
    result: Any
    principal: str
    undone: asyncio.Task | None = None


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
    proposals: dict[str, _StoredProposal] = field(default_factory=dict)
    commits: dict[str, asyncio.Task] = field(default_factory=dict)
    receipts: dict[str, _StoredReceipt] = field(default_factory=dict)
    spent: dict[tuple[str, str], int] = field(default_factory=dict)  # (block id, measure) -> exact value at scale 18
    auto_seen: dict[str, tuple[asyncio.Task, int]] = field(default_factory=dict)
    sweeps: int = 0  # INTENTs since start, for the periodic sweep (sweep.py)

    def now(self) -> int:
        return int(self.clock())
