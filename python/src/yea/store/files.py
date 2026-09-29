"""File primitives the file store builds on: exclusive create, atomic write, and a forgiving read."""

from __future__ import annotations

import os
import secrets
from pathlib import Path


def default_store_dir() -> Path:
    """``$YEA_HOME/store``, else ``~/.yea/store``."""
    home = os.environ.get("YEA_HOME")
    return Path(home) / "store" if home else Path.home() / ".yea" / "store"


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
