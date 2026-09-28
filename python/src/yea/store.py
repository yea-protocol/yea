"""The approval store (docs/framework/SPEC-approval.md §8): consumed approvals, job receipts,
undo markers, the usage ledger and consents. ``FileStore`` shares its on-disk layout with the
TypeScript servers and the ``yea`` command."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import secrets
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, NamedTuple, Protocol

from ._json import b64url_encode, dumps, loads

RECEIPT_ID = re.compile(r"r_[A-Za-z0-9_-]{8,32}")
_B64URL = re.compile(r"[A-Za-z0-9_-]{1,128}")
_MEASURE = re.compile(r"[a-z][a-z0-9_.\-]{0,63}")
LOCK_WAIT = 2.0  # seconds to wait for a ledger lock before failing closed
LOCK_STALE = 30.0  # a lock file older than this was left by a crashed process


class LedgerKey(NamedTuple):
    """A policy grant block id and a measure."""

    block: str
    of: str


@dataclass(frozen=True)
class Reservation:
    key: LedgerKey
    amount: int  # an exact value: an integer at scale 18
    id: str


class StoreError(Exception):
    """The store couldn't do what was asked. Callers fail closed."""


class ApprovalStore(Protocol):
    async def consume_once(self, id: str, expires_at: int) -> bool: ...
    async def put_receipt(self, r: dict) -> None: ...
    async def get_receipt(self, id: str) -> dict | None: ...
    async def claim_undo(self, id: str) -> bool: ...
    async def release_undo(self, id: str) -> None: ...
    async def mark_undone(self, id: str) -> None: ...
    async def reserve(self, k: LedgerKey, amount: int, max: int) -> Reservation | None: ...
    async def settle(self, r: Reservation) -> None: ...
    async def release(self, r: Reservation) -> None: ...
    async def used(self, k: LedgerKey) -> int: ...
    async def put_consent(self, plan_hash: str, grant: str) -> None: ...
    async def get_consent(self, plan_hash: str) -> str | None: ...


def is_receipt_id(v: Any) -> bool:
    """``r_`` and 8 to 32 characters of ``A-Z a-z 0-9 _ -`` (§7)."""
    return isinstance(v, str) and RECEIPT_ID.fullmatch(v) is not None


def _receipt_id(v: Any) -> str:
    if not is_receipt_id(v):
        raise StoreError(f"not a receipt id: {v!r}")
    return v


def _key(k: LedgerKey) -> LedgerKey:
    if not (isinstance(k.block, str) and _B64URL.fullmatch(k.block) and isinstance(k.of, str) and _MEASURE.fullmatch(k.of)):
        raise StoreError(f"bad ledger key {k!r}")
    return k


def _plan_hash(v: Any) -> str:
    if not (isinstance(v, str) and _B64URL.fullmatch(v)):
        raise StoreError(f"not a plan hash: {v!r}")
    return v


def _reservation_id() -> str:
    """``v_`` and 12 b64url characters (9 random bytes)."""
    return "v_" + b64url_encode(os.urandom(9))


# ------------------------------------------------------------------ memory


@dataclass
class _Ledger:
    settled: int = 0
    reserved: dict[str, int] = field(default_factory=dict)

    @property
    def used(self) -> int:
        return self.settled + sum(self.reserved.values())


class MemoryStore:
    """One process's store. Fine for a single-process server; totals reset on restart."""

    def __init__(self, now: Any = time.time):
        self._now = now
        self._consumed: dict[str, int] = {}
        self._receipts: dict[str, dict] = {}
        self._claimed: set[str] = set()
        self._undone: set[str] = set()
        self._ledger: dict[LedgerKey, _Ledger] = {}
        self._consents: dict[str, str] = {}

    async def consume_once(self, id: str, expires_at: int) -> bool:
        if id in self._consumed:
            return False
        if len(self._consumed) > 10_000:
            now = int(self._now())
            self._consumed = {k: e for k, e in self._consumed.items() if e > now}
        self._consumed[id] = expires_at
        return True

    async def put_receipt(self, r: dict) -> None:
        self._receipts[_receipt_id(r.get("id"))] = json.loads(json.dumps(r))

    async def get_receipt(self, id: str) -> dict | None:
        r = self._receipts.get(id) if is_receipt_id(id) else None
        return json.loads(json.dumps(r)) if r is not None else None

    async def claim_undo(self, id: str) -> bool:
        _receipt_id(id)
        if id in self._claimed or id in self._undone:
            return False
        self._claimed.add(id)
        return True

    async def release_undo(self, id: str) -> None:
        self._claimed.discard(_receipt_id(id))

    async def mark_undone(self, id: str) -> None:
        self._undone.add(_receipt_id(id))
        self._claimed.discard(id)

    async def reserve(self, k: LedgerKey, amount: int, max: int) -> Reservation | None:
        led = self._ledger.setdefault(_key(k), _Ledger())
        if led.used + amount > max:
            return None
        r = Reservation(k, amount, _reservation_id())
        led.reserved[r.id] = amount
        return r

    async def settle(self, r: Reservation) -> None:
        led = self._ledger.get(r.key)
        if led is not None and r.id in led.reserved:
            led.settled += led.reserved.pop(r.id)

    async def release(self, r: Reservation) -> None:
        led = self._ledger.get(r.key)
        if led is not None:
            led.reserved.pop(r.id, None)

    async def used(self, k: LedgerKey) -> int:
        led = self._ledger.get(_key(k))
        return led.used if led else 0

    async def put_consent(self, plan_hash: str, grant: str) -> None:
        self._consents[_plan_hash(plan_hash)] = grant

    async def get_consent(self, plan_hash: str) -> str | None:
        return self._consents.get(_plan_hash(plan_hash))


# ------------------------------------------------------------------ files


def default_store_dir() -> Path:
    """``$YEA_HOME/store``, else ``~/.yea/store``."""
    home = os.environ.get("YEA_HOME")
    return Path(home) / "store" if home else Path.home() / ".yea" / "store"


def _create_excl(path: Path, text: str = "") -> bool:
    """Create ``path`` only if it doesn't exist (O_EXCL). True if this call created it."""
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError:
        return False
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(text)
    return True


def _write_atomic(path: Path, text: str) -> None:
    """Write to a temp file beside ``path``, then rename. The temp name is unique, so two
    writers of the same file don't share one."""
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    tmp = path.with_name(f"{path.name}.{secrets.token_hex(6)}.tmp")
    fd = os.open(tmp, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(text)
    os.replace(tmp, path)


def _read(path: Path) -> str | None:
    try:
        return path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None


class FileStore:
    """The shared on-disk store (§8), for local stdio servers and the ``yea`` command::

        consumed/<b64url(sha256(id))>   O_EXCL marker holding exp as text
        undo/<receipt id>.claim, .done  O_EXCL markers
        receipts/<receipt id>.json      the job receipt, plain JSON (not byte-pinned: results may hold floats)
        ledger/<block>/<of>.json        {"settled": "<decimal>", "reserved": {"<rid>": "<decimal>"}}
        consents/<planHash>             the pg1. consent grant
    """

    def __init__(self, root: str | os.PathLike[str] | None = None):
        self.root = Path(root) if root is not None else default_store_dir()

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
        return _create_excl(undo / f"{id}.claim")

    async def release_undo(self, id: str) -> None:
        (self.root / "undo" / f"{_receipt_id(id)}.claim").unlink(missing_ok=True)

    async def mark_undone(self, id: str) -> None:
        _create_excl(self.root / "undo" / f"{_receipt_id(id)}.done")

    def _ledger_path(self, k: LedgerKey) -> Path:
        k = _key(k)
        return self.root / "ledger" / k.block / f"{k.of}.json"

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
        return _read(self.root / "consents" / _plan_hash(plan_hash))


async def _acquire(lock: Path) -> str:
    """Take a lock file with O_EXCL, retrying for ``LOCK_WAIT``. It holds a random token, so only
    its holder releases it. A lock older than ``LOCK_STALE`` was left by a crashed process."""
    token = f"{os.getpid()}:{secrets.token_hex(8)}"
    deadline = time.monotonic() + LOCK_WAIT
    while not _create_excl(lock, token):
        _break_if_stale(lock)
        if time.monotonic() > deadline:
            raise StoreError(f"timed out waiting for {lock}")
        await asyncio.sleep(0.01)
    return token


def _break_if_stale(lock: Path) -> None:
    """Remove a stale lock without removing a fresh one someone just took: move it aside under a
    unique name, then delete it only if it's the same file we found stale; else put it back."""
    try:
        st = lock.stat()
        if time.time() - st.st_mtime <= LOCK_STALE:
            return
        aside = lock.with_name(f"{lock.name}.{secrets.token_hex(6)}.stale")
        os.rename(lock, aside)
    except FileNotFoundError:
        return
    moved = aside.stat()
    if (moved.st_ino, moved.st_dev) == (st.st_ino, st.st_dev):
        aside.unlink(missing_ok=True)
        return
    try:
        os.link(aside, lock)  # someone's fresh lock: restore it unless a third holder took the name
    except FileExistsError:
        pass
    aside.unlink(missing_ok=True)


def _still_held(lock: Path, token: str) -> None:
    if _read(lock) != token:
        raise StoreError(f"lost {lock} while holding it; nothing was written")


def _release(lock: Path, token: str) -> None:
    if _read(lock) == token:
        lock.unlink(missing_ok=True)


def _parse_ledger(text: str | None) -> _Ledger:
    """A ledger file, or an empty ledger if there's none. A corrupt one fails closed."""
    if text is None:
        return _Ledger()
    try:
        d = json.loads(text)
        return _Ledger(int(d["settled"]), {r: int(a) for r, a in d["reserved"].items()})
    except (ValueError, KeyError, TypeError, AttributeError) as e:
        raise StoreError(f"corrupt ledger file: {e}") from None
