"""A FileStore's id (SPEC-approval §8): ``<root>/id``, a store id and nothing else. Whichever process
needs it first makes it, once and whole; every other process that shares the root, and ``yea
approve``, reads the same one. As ts/src/file-store/store-id.ts."""

from __future__ import annotations

import errno
from pathlib import Path

from .contract import StoreError, is_store_id, new_store_id
from .files import _create_whole, _read_regular, _write_atomic
from .lock import _acquire, _release, _still_held

# What ``link`` fails with where the filesystem has no hard links: FAT, exFAT, many SMB shares.
_NO_HARD_LINKS = {errno.ENOTSUP, errno.EPERM, errno.ENOSYS}


def _read_store_id(root: Path) -> str | None:
    """The id of the store at ``root``, or None if none has been made; a store error if it isn't one."""
    path = root / "id"
    try:
        text = _read_regular(path)
    except (OSError, ValueError) as e:  # UnicodeDecodeError is a ValueError
        raise StoreError(f"can't read the store id at {path}: {e}") from None
    if text is not None and not is_store_id(text):
        raise StoreError(f"{path} doesn't hold a store id, so this store can't be used")
    return text


async def _ensure_store_id(root: Path) -> str:
    """The id of the store at ``root``, made now if it has none: the first to make one wins."""
    found = _read_store_id(root)
    if found is not None:
        return found
    made = new_store_id()
    if await _create_id(root, made):
        return made
    theirs = _read_store_id(root)
    if theirs is None:
        raise StoreError(f"the store id at {root / 'id'} was removed as it was made")
    return theirs


async def _create_id(root: Path, made: str) -> bool:
    """Make ``<root>/id`` hold ``made``, once and whole; False if another process made one first.
    An OS error is a store error naming the file."""
    path = root / "id"
    try:
        try:
            return _create_whole(path, made)
        except OSError as e:
            if e.errno not in _NO_HARD_LINKS:
                raise
        return await _create_id_locked(root, made)
    except OSError as e:
        raise StoreError(f"can't make the store id at {path}: {e}") from None


async def _create_id_locked(root: Path, made: str) -> bool:
    """Where the filesystem has no hard links: under the lock file ``<root>/id.lock``, look again,
    and only if there's still no id, write it to a temp file and rename it into place. Still once,
    since on such a filesystem every maker takes the lock first, and whole, since a rename is."""
    lock = root / "id.lock"
    token = await _acquire(lock)
    try:
        if _read_store_id(root) is not None:
            return False
        _still_held(lock, token)  # a lock broken as stale (a holder paused over 30 s) let another in
        _write_atomic(root / "id", made)
        return True
    finally:
        _release(lock, token)
