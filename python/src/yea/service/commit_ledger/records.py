"""What the commit ledger keeps and is given: a stored proposal and receipt, the grant evaluation a
commit brings with it (ADR-0002), and the receipt a commit issues. Like
ts/src/service/commit-ledger/records.ts."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Any

from ...errors import YeaError
from ...store import LedgerKey, Reservation
from ..plan import Plan
from ..util import Emit, random_id
from .runs import Run


@dataclass
class StoredProposal:
    """``requester``: the holder key whose verified proof asked for this proposal; only it may commit
    it. ``principal``: the principal whose grant authorized the INTENT, if any."""

    proposal: dict
    plan: Plan
    principal: str | None
    requester: str | None


@dataclass
class StoredReceipt:
    """``principal``: the issuer of the grant the commit ran under; only it may undo or replay it."""

    receipt: dict
    plan: Plan
    result: Any
    principal: str


# The amount the usage ledger holds against each `total`, settled and reserved, by key.
Used = Mapping[LedgerKey, int]


@dataclass(frozen=True)
class TotalLimit:
    """A ``total`` caveat a COMMIT counts against: its block, measure and exact ceiling (scale 18)."""

    id: str
    of: str
    max: int


@dataclass(frozen=True)
class Admitted:
    """The grant that admits a proposal: its principal, and the ``total`` limits it counts against."""

    iss: str
    totals: list[TotalLimit]


# Grant evaluation with the limits included (ADR-0002), over the request's own grants: the grant
# that admits the proposal given what `used` holds, or the error that says why none does.
Admit = Callable[[dict, Used], "Admitted | YeaError"]


@dataclass(frozen=True)
class Doubt:
    """Whom a commit in doubt ran for, and its capability (runs.py): while one is, an auto INTENT for
    the same principal and capability only proposes, since the agent may be sending it again."""

    principal: str
    capability: str


@dataclass(frozen=True)
class InFlight:
    """A commit's run that hasn't finished, the doubt it would leave, and the reservations it holds."""

    run: Run
    doubt: Doubt
    held: list[Reservation]


@dataclass
class Records:
    """Everything the ledger keeps, by id."""

    proposals: dict[str, StoredProposal] = field(default_factory=dict)
    # A commit's run, by proposal id: in flight, done or in doubt. A failed run is removed, to allow a retry.
    runs: dict[str, Run] = field(default_factory=dict)
    # The commits whose run hasn't finished, by proposal id, so one stranded on a closed loop is found.
    in_flight: dict[str, InFlight] = field(default_factory=dict)
    # The commits in doubt, by proposal id, kept with their run until their proposal is forgotten.
    in_doubt: set[str] = field(default_factory=set)
    receipts: dict[str, StoredReceipt] = field(default_factory=dict)
    # An undo's run, by receipt id, removed like a commit's when it fails.
    undos: dict[str, Run] = field(default_factory=dict)


@dataclass(frozen=True)
class Commit:
    """A COMMIT of a stored proposal: the frame it answers, its principal, and its grants' evaluation."""

    id: str
    stored: StoredProposal
    principal: str
    admit: Admit


@dataclass(frozen=True)
class Undo:
    """An UNDO of a stored receipt by the principal who committed it."""

    id: str
    stored: StoredReceipt
    principal: str


@dataclass(frozen=True)
class Answer:
    """The frame a run answers, and where its EVENTs go."""

    re: str
    emit: Emit


def receipt_for(proposal: dict, result: Any, at: int) -> dict:
    """The receipt for a proposal applied at ``at``, with the plan's result."""
    receipt: dict[str, Any] = {
        "id": random_id("r"), "proposal": proposal["id"], "capability": proposal["capability"],
        "summary": proposal["summary"], "at": at, "effects": proposal["effects"],
        "undo": {"until": at + proposal["undo"]["window"]} if proposal["undo"] else None,
    }
    if "uses" in proposal:
        receipt["uses"] = proposal["uses"]
    if result is not None:
        receipt["result"] = result
    return receipt
