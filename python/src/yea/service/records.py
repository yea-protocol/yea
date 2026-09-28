"""What a service remembers: registered capabilities, the proposals it made and the receipts it gave."""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

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
