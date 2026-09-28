"""Totals reserved before a plan runs, all or none, and settled or released after (SPEC-approval §5)."""

from __future__ import annotations

from ..store import ApprovalStore, LedgerKey, Reservation
from .policy import Policy


async def reserve_all(store: ApprovalStore, wanted: tuple[tuple[LedgerKey, int, int], ...]) -> list[Reservation] | None:
    """Reserve every (key, amount, max) or none: if one would pass its limit, release the ones
    already made and return None, so the call asks instead of running."""
    held: list[Reservation] = []
    try:
        for key, amount, mx in wanted:
            r = await store.reserve(key, amount, mx)
            if r is None:
                await release_all(store, held)
                return None
            held.append(r)
    except BaseException:
        await release_all(store, held)
        raise
    return held


async def spent(store: ApprovalStore, policy: Policy) -> dict[LedgerKey, int]:
    """Read ahead what ``decide`` needs from the store: the used amount for each policy total.
    Pass ``lambda k: amounts.get(k, 0)`` as its ``used``."""
    return {LedgerKey(bid, lim["of"]): await store.used(LedgerKey(bid, lim["of"])) for bid, lim in policy.totals}


async def settle_all(store: ApprovalStore, held: list[Reservation]) -> None:
    for r in held:
        await store.settle(r)


async def release_all(store: ApprovalStore, held: list[Reservation]) -> None:
    for r in held:
        await store.release(r)
