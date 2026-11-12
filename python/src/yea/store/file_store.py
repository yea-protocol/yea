"""The file store: the on-disk layout shared with the TypeScript servers and the ``yea`` command."""

from __future__ import annotations

import errno
import hashlib
import json
import os
import sys
from pathlib import Path
from typing import Any

from .._json import b64url_encode, dumps, loads
from .contract import (
    LedgerKey,
    Reservation,
    StoreError,
    _key,
    _Ledger,
    _plan_hash,
    _receipt_id,
    _reservation_id,
    is_receipt_id,
)
from .files import NotRegularFile, _create_excl, _read, _read_regular, _write_atomic, default_store_dir
from .lock import CLAIM_STALE, _acquire, _break_if_stale, _release, _still_held, _token
from .store_id import _ensure_store_id


class FileStore:
    """The shared on-disk store (§8), for local stdio servers and the ``yea`` command::

        consumed/<b64url(sha256(id))>   O_EXCL marker holding exp as text
        undo/<receipt id>.claim, .done  O_EXCL markers
        receipts/<receipt id>.json      the job receipt, plain JSON (not byte-pinned: results may hold floats)
        ledger/<block>/<of>.json        {"settled": "<decimal>", "reserved": {"<rid>": "<decimal>"}}
        ledger/<block>/<of>@<every>/<start>.json   the same, for one period of a total with every
        consents/<planHash>             the pg1. consent grant
        id                              the store id, created once
    """

    def __init__(self, root: str | os.PathLike[str] | None = None):
        self.root = Path(root) if root is not None else default_store_dir()
        self._id: str | None = None

    async def store_id(self) -> str:
        """``<root>/id``, made by the first process that needs it, then kept for this instance (§8)."""
        if self._id is None:
            self._id = await _ensure_store_id(self.root)
        return self._id

    async def consume_once(self, id: str, expires_at: int) -> bool:
        name = b64url_encode(hashlib.sha256(id.encode("utf-8")).digest())
        return _create_excl(self.root / "consumed" / name, str(expires_at))

    async def put_receipt(self, r: dict) -> None:
        _write_atomic(self.root / "receipts" / f"{_receipt_id(r.get('id'))}.json", dumps(r))

    async def get_receipt(self, id: str) -> dict | None:
        if not is_receipt_id(id):
            return None
        text = _read(self.root / "receipts" / f"{id}.json")
        return loads(text) if text is not None else None

    async def claim_undo(self, id: str) -> bool:
        undo = self.root / "undo"
        if (undo / f"{_receipt_id(id)}.done").exists():
            return False
        claim, token = undo / f"{id}.claim", _token()
        if not _create_excl(claim, token):
            _break_if_stale(claim, CLAIM_STALE)  # a revert that crashed mid-way can be tried again
            if not _create_excl(claim, token):
                return False
        # A revert that finished (and released its claim) after the done check above: never twice.
        if (undo / f"{id}.done").exists():
            _release(claim, token)
            return False
        return True

    async def release_undo(self, id: str) -> None:
        (self.root / "undo" / f"{_receipt_id(id)}.claim").unlink(missing_ok=True)

    async def mark_undone(self, id: str) -> None:
        _create_excl(self.root / "undo" / f"{_receipt_id(id)}.done")

    def _ledger_path(self, k: LedgerKey) -> Path:
        """``ledger/<block>/<of>.json``, or for one period, ``ledger/<block>/<of>@<every>/<start>.json``."""
        k = _key(k)
        block = self.root / "ledger" / k.block
        if k.period is None:
            return block / f"{k.of}.json"
        return block / f"{k.of}@{k.period.every}" / f"{k.period.start}.json"

    async def _update(self, k: LedgerKey, change: Any) -> Any:
        """Read, change and write one ledger file under its lock. ``change(ledger)`` returns the
        result and whether to write."""
        path = self._ledger_path(k)
        lock = path.with_suffix(".lock")
        token = await _acquire(lock)
        try:
            led = _parse_ledger(_read(path))
            out, write = change(led)
            if write:
                _still_held(lock, token)  # a lock broken while we paused must not be written through
                _write_atomic(path, json.dumps(
                    {"settled": str(led.settled), "reserved": {r: str(a) for r, a in led.reserved.items()}},
                    separators=(",", ":"),
                ))
                _still_held(lock, token)  # and if it was broken during the write, say so
            return out
        finally:
            _release(lock, token)

    async def reserve(self, k: LedgerKey, amount: int, max: int) -> Reservation | None:
        def change(led: _Ledger) -> tuple[Reservation | None, bool]:
            if led.used + amount > max:
                return None, False
            r = Reservation(k, amount, _reservation_id())
            led.reserved[r.id] = amount
            return r, True

        return await self._update(k, change)

    async def settle(self, r: Reservation) -> None:
        def change(led: _Ledger) -> tuple[None, bool]:
            if r.id not in led.reserved:
                return None, False
            led.settled += led.reserved.pop(r.id)
            return None, True

        await self._update(r.key, change)

    async def release(self, r: Reservation) -> None:
        def change(led: _Ledger) -> tuple[None, bool]:
            return None, led.reserved.pop(r.id, None) is not None

        await self._update(r.key, change)

    async def used(self, k: LedgerKey) -> int:
        return _parse_ledger(_read(self._ledger_path(k))).used

    async def put_consent(self, plan_hash: str, grant: str) -> None:
        _write_atomic(self.root / "consents" / _plan_hash(plan_hash), grant)

    async def get_consent(self, plan_hash: str) -> str | None:
        """The consent stored for a plan, or None. It's read as a server key is (``_read_regular``),
        and one that is there but can't be read that way (a mode or owner that shuts this user out;
        a symlink, directory, FIFO or device in its place; over 64 KiB; bytes that aren't UTF-8)
        counts as absent, with a line on stderr: it can only mean asking again, never an fs error in
        the model's context (SPEC-approval §8)."""
        path = self.root / "consents" / _plan_hash(plan_hash)
        try:
            return _read_regular(path)
        except (OSError, ValueError) as e:  # UnicodeDecodeError is a ValueError
            print(f"yea: the consent at {path} can't be read ({_why(e)}), so it counts as absent", file=sys.stderr)
            return None


def _why(e: Exception) -> str:
    """An error's errno name (``EACCES``), as TypeScript's store logs it; why a file isn't regular;
    or its type."""
    if isinstance(e, NotRegularFile):
        return str(e)
    code = getattr(e, "errno", None)
    return errno.errorcode.get(code, type(e).__name__) if isinstance(code, int) else type(e).__name__


def _parse_ledger(text: str | None) -> _Ledger:
    """A ledger file, or an empty ledger if there's none. A corrupt one fails closed."""
    if text is None:
        return _Ledger()
    try:
        d = json.loads(text)
        return _Ledger(int(d["settled"]), {r: int(a) for r, a in d["reserved"].items()})
    except (ValueError, KeyError, TypeError, AttributeError) as e:
        raise StoreError(f"corrupt ledger file: {e}") from None
