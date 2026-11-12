"""File primitives the file store builds on: exclusive create, atomic write, a forgiving read, and
reading a file only if it's a regular one."""

from __future__ import annotations

import os
import secrets
import stat
from pathlib import Path

_MAX_REGULAR = 64 * 1024


def yea_home() -> Path:
    """``$YEA_HOME``, else ``~/.yea``: where the store, keys and policy live."""
    home = os.environ.get("YEA_HOME")
    return Path(home) if home else Path.home() / ".yea"


def default_store_dir() -> Path:
    """``$YEA_HOME/store``, else ``~/.yea/store``."""
    return yea_home() / "store"


def make_private_dirs(path: Path) -> None:
    """Create ``path`` and any missing parents, each ``0700`` (``mkdir -p`` would give the parents
    the umask's mode, e.g. group-writable under umask 002), as Node's recursive mkdir does."""
    missing = []
    while not path.exists():
        missing.append(path)
        path = path.parent
    for d in reversed(missing):
        try:
            d.mkdir(mode=0o700)
        except FileExistsError:
            pass


def _create_excl(path: Path, text: str = "") -> bool:
    """Create ``path`` only if it doesn't exist (O_EXCL). True if this call created it."""
    make_private_dirs(path.parent)
    try:
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError:
        return False
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(text)
    return True


def _create_whole(path: Path, text: str) -> bool:
    """Create ``path`` holding ``text`` only if it doesn't exist, and whole: written to a uniquely
    named temp file, then linked into place, which fails if the name exists. False if it did."""
    make_private_dirs(path.parent)
    tmp = path.with_name(f"{path.name}.{secrets.token_hex(6)}.tmp")
    fd = os.open(tmp, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(text)
    try:
        os.link(tmp, path)
        return True
    except FileExistsError:
        return False
    finally:
        tmp.unlink(missing_ok=True)


def _write_atomic(path: Path, text: str) -> None:
    """Write to a temp file beside ``path``, then rename. The temp name is unique, so two
    writers of the same file don't share one."""
    make_private_dirs(path.parent)
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


class NotRegularFile(OSError):
    """A file ``_read_regular`` won't read: not a regular file, or too big."""


def _read_regular(path: Path) -> str | None:
    """The text of the regular file at ``path``, or None if there's none, read by
    ``_read_regular_bytes``; bytes that aren't UTF-8 are a ``UnicodeDecodeError``."""
    data = _read_regular_bytes(path)
    return None if data is None else data.decode("utf-8")


def _read_regular_bytes(path: Path) -> bytes | None:
    """The bytes of the regular file at ``path``, or None if there's none. It's opened without
    following a symlink and without blocking on a FIFO (O_NOFOLLOW, O_NONBLOCK), checked on the open
    file, and read to at most 64 KiB, as a server key is. An OS error (a symlink is ELOOP) is raised
    as it is; anything else that isn't a regular file, or is longer, is a ``NotRegularFile``."""
    try:
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
    except FileNotFoundError:
        return None
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise NotRegularFile("not a regular file")
        data = b""
        while chunk := os.read(fd, _MAX_REGULAR + 1 - len(data)):
            data += chunk
            if len(data) > _MAX_REGULAR:
                raise NotRegularFile("over 64 KiB")
    finally:
        os.close(fd)
    return data
