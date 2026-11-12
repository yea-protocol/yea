"""Pending files (docs/framework/SPEC-approval.md §6, Short ids): each consent code a server hands
out, written under a short id in its store's ``pending/``, where ``yea approve <id>`` on the same
account finds it. The format is shared with the TypeScript writers (``conformance/pending.json``);
the reader is the TypeScript ``yea approve``. A file is the code on one line and nothing else."""

from __future__ import annotations

import os
import re
import secrets
from pathlib import Path
from typing import Any

from ..grants import consent_expiry, decode_consent_code
from .files import _read_regular_bytes, _write_atomic

# The ids ``yea approve <id>`` accepts, matched whole: never a path, and no prefix search.
PENDING_ID = re.compile(r"^[A-Za-z0-9_-]{8,32}$")

# Lowercase base32: 32 letters and digits, so a random byte's low 5 bits pick one evenly.
_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567"
_ID_LENGTH = 10


def new_pending_id() -> str:
    """A new id: 10 random characters of lowercase base32, which never start with ``-``."""
    return "".join(_ALPHABET[b & 31] for b in secrets.token_bytes(_ID_LENGTH))


def pending_file(code: str) -> str:
    """What a pending file holds for ``code``: the code verbatim, on one line."""
    return f"{code}\n"


def _read(path: Path) -> str | None:
    """The file's first line, read as ``_read_regular_bytes`` reads one (a regular file of at most
    64 KiB, opened without following a symlink); None for anything it won't read."""
    try:
        data = _read_regular_bytes(path)
    except OSError:  # a symlink, unreadable, not a regular file, or over 64 KiB (NotRegularFile)
        return None
    return None if data is None else data.decode("utf-8", errors="replace").split("\n", 1)[0].strip()


class PendingCodes:
    """The pending codes in one directory: ``<store>/pending`` for a server."""

    def __init__(self, dir: str | os.PathLike[str]):
        self.dir = Path(dir)

    def put(self, code: str, now: int) -> str:
        """Write ``code`` and return its id. A file already there for the code's service and
        proposal is rewritten under its id, so an id handed out earlier still works; other files
        for the pair, and every file whose consent has expired (``consent_expiry``), are removed."""
        c = decode_consent_code(code)
        entries = self._entries()
        same = [i for i, e in entries.items() if _same_pair(e, c["service"], c["proposal"])]
        kept = same[0] if same else self._fresh_id()
        for i, e in entries.items():
            if i != kept and (i in same or consent_expiry(e) <= now):
                self._remove(i)
        _write_atomic(self.dir / kept, pending_file(code))
        return kept

    def drop(self, service: str, proposal: str) -> None:
        """Remove the files for one service and proposal: its plan ran."""
        for i, e in self._entries().items():
            if _same_pair(e, service, proposal):
                self._remove(i)

    def _ids(self) -> list[str]:
        try:
            return [n for n in os.listdir(self.dir) if PENDING_ID.match(n)]
        except FileNotFoundError:
            return []

    def _entries(self) -> dict[str, dict[str, Any]]:
        """Every file here that reads as a code, by id; anything else is left alone."""
        out = {}
        for i in self._ids():
            code = _read(self.dir / i)
            try:
                out[i] = decode_consent_code(code or "")
            except ValueError:
                continue
        return out

    def _fresh_id(self) -> str:
        taken = set(self._ids())
        while (i := new_pending_id()) in taken:
            pass
        return i

    def _remove(self, i: str) -> None:
        (self.dir / i).unlink(missing_ok=True)


def _same_pair(c: dict[str, Any], service: str, proposal: str) -> bool:
    return c.get("service") == service and c.get("proposal") == proposal


def pending_codes_of(store: Any) -> PendingCodes | None:
    """The pending files beside a FileStore's consents, or None for any other store. By name along
    the class's ancestry, as ``is_memory_store`` does, so a second copy of the SDK still counts."""
    if any(c.__name__ == "FileStore" and c.__module__.startswith("yea") for c in type(store).__mro__):
        return PendingCodes(Path(store.root) / "pending")
    return None
