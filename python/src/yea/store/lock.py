"""Lock files with owner tokens: taken with O_EXCL, broken only when stale, released only by their holder."""

from __future__ import annotations

import asyncio
import os
import secrets
import time
from pathlib import Path

from .contract import StoreError
from .files import _create_excl, _read

LOCK_WAIT = 2.0  # seconds to wait for a ledger lock before failing closed
LOCK_STALE = 30.0  # a lock file older than this was left by a crashed process
CLAIM_STALE = 600  # an undo claim this old with no done marker was left by a crashed revert


def _token() -> str:
    return f"{os.getpid()}:{secrets.token_hex(8)}"


async def _acquire(lock: Path) -> str:
    """Take a lock file with O_EXCL, retrying for ``LOCK_WAIT``. It holds a random token, so only
    its holder releases it. A lock older than ``LOCK_STALE`` was left by a crashed process."""
    token = _token()
    deadline = time.monotonic() + LOCK_WAIT
    while not _create_excl(lock, token):
        _break_if_stale(lock)
        if time.monotonic() > deadline:
            raise StoreError(f"timed out waiting for {lock}")
        await asyncio.sleep(0.01)
    return token


def _break_if_stale(lock: Path, stale: float | None = None) -> None:
    """Remove a stale lock (or undo claim) without removing a fresh one someone just took: read
    its token, move it aside under a unique name, and delete it only if the moved file still
    holds that token; otherwise put it back. Inodes aren't compared, since they get reused."""
    try:
        if time.time() - lock.stat().st_mtime <= (LOCK_STALE if stale is None else stale):
            return
        token = lock.read_text(encoding="utf-8")
        aside = lock.with_name(f"{lock.name}.{secrets.token_hex(6)}.stale")
        os.rename(lock, aside)
    except FileNotFoundError:
        return
    if _read(aside) != token:
        try:
            os.link(aside, lock)  # someone's fresh one: restore it unless a third holder took the name
        except FileExistsError:
            pass
    aside.unlink(missing_ok=True)


def _still_held(lock: Path, token: str) -> None:
    if _read(lock) != token:
        raise StoreError(f"lost {lock} while holding it; nothing was written")


def _release(lock: Path, token: str) -> None:
    if _read(lock) == token:
        lock.unlink(missing_ok=True)
