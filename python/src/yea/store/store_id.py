"""A FileStore's id (SPEC-approval §8): ``<root>/id``, a store id and nothing else. Whichever process
needs it first makes it, once and whole; every other process that shares the root, and ``yea
approve``, reads the same one. As ts/src/file-store/store-id.ts."""

from __future__ import annotations

from pathlib import Path

from .contract import StoreError, is_store_id, new_store_id
from .files import _create_whole, _read_regular


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


def _ensure_store_id(root: Path) -> str:
    """The id of the store at ``root``, made now if it has none: the first to link one in wins."""
    found = _read_store_id(root)
    if found is not None:
        return found
    made = new_store_id()
    if _create_whole(root / "id", made):
        return made
    theirs = _read_store_id(root)
    if theirs is None:
        raise StoreError(f"the store id at {root / 'id'} was removed as it was made")
    return theirs
