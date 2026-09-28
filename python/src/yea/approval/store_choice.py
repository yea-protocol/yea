"""Which store a server uses by default, and when it must refuse to start (SPEC-approval §8)."""

from __future__ import annotations

from ..store import ApprovalStore, FileStore, MemoryStore
from .policy import Policy


def choose_store(http: bool, store: ApprovalStore | None, policy: Policy, single_process: bool = False) -> ApprovalStore:
    """§8: stdio defaults to FileStore; HTTP to MemoryStore, which it refuses when the policy has
    a ``total`` limit unless the author passes a store or says the server is one process."""
    if store is not None:
        return store
    if not http:
        return FileStore()
    if policy.totals and not single_process:
        raise ValueError("an HTTP server with a total limit needs a shared store: pass store=…, or single_process=True")
    return MemoryStore()
