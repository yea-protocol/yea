"""Totals reserved before a plan runs, all or none, and settled or released after (SPEC-approval §5)."""

from __future__ import annotations

from ..grants import Grant, total_keys
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


async def spent(store: ApprovalStore, policy: Policy, now: int) -> dict[LedgerKey, int]:
    """Read ahead what ``decide`` needs from the store at ``now``: the used amount for each policy
    total, in the period it counts in then. Pass ``lambda k: amounts.get(k, 0)`` as its ``used``,
    and the same ``now``."""
    g = policy.grant
    keys = total_keys(g.blocks, g.block_ids, now) if isinstance(g, Grant) else []
    return {k: await store.used(k) for k in keys}


async def settle_all(store: ApprovalStore, held: list[Reservation]) -> None:
    for r in held:
        await store.settle(r)


async def release_all(store: ApprovalStore, held: list[Reservation]) -> None:
    for r in held:
        await store.release(r)
