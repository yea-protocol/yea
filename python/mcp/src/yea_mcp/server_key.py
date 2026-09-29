"""The job server's own key (SPEC-mcp-py ``yea()``): named, created on first run, and read only
when its file and directory are this user's alone. It's read once."""

from __future__ import annotations

import os
import re
import secrets
import stat
from pathlib import Path
from typing import Any

from yea import KeyPair
from yea._json import b64url_encode, is_b64url
from yea.store.files import make_private_dirs, yea_home

from .util import warn_once

NAME = re.compile(r"[a-z0-9._-]{1,64}")


def check_name(name: Any) -> str:
    """Server names name a key file and appear in consent codes."""
    if not isinstance(name, str) or not NAME.fullmatch(name):
        raise ValueError(f"yea(): name must match [a-z0-9._-]{{1,64}}, got {name!r}")
    return name


def default_key_path(name: str) -> Path:
    return yea_home() / "server" / f"{name}.key"


def _check_dir(d: Path) -> None:
    """The key's directory is this user's and writable by no one else; its parent is this user's or
    root's, and not writable by its group or others unless sticky (like /tmp), as mcp-ts."""
    if not hasattr(os, "geteuid"):
        return  # no POSIX owners (Windows): as mcp-ts, only the file checks apply
    st = d.lstat()
    if stat.S_ISLNK(st.st_mode) or not stat.S_ISDIR(st.st_mode) or st.st_uid != os.geteuid() or st.st_mode & 0o022:
        raise ValueError(f"yea(): refusing the server key: {d} must be a directory owned by this user, "
                         "writable by no one else")
    p = d.parent.stat()
    if p.st_uid not in (os.geteuid(), 0) or (p.st_mode & 0o022 and not p.st_mode & stat.S_ISVTX):
        raise ValueError(f"yea(): refusing the server key: {d.parent} can be changed by other users (chmod 755 it)")


def _create_key(path: Path) -> None:
    """Write the seed to a temp file, then link it into place: the link fails if a key exists, and
    a reader never sees a half-written file."""
    tmp = path.with_name(f".{path.name}.{secrets.token_hex(6)}.tmp")
    fd = os.open(tmp, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(b64url_encode(secrets.token_bytes(32)) + "\n")
        try:
            os.link(tmp, path)
        except FileExistsError:
            pass
    finally:
        tmp.unlink(missing_ok=True)


MAX_KEY_FILE = 64 * 1024  # as mcp-ts (ts/src/key-file.ts MAX_PRIVATE_FILE)


def _read_key(path: Path) -> str:
    """Open without following a symlink, check the open file, and read that same file, at most
    64 KiB of it (a file that grows after the check still can't be read past the cap)."""
    try:
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
    except OSError as e:
        raise ValueError(f"yea(): refusing the server key: {path} is a symlink or unreadable ({e.strerror})") from None
    try:
        return _read_checked(path, fd)
    finally:
        os.close(fd)


def _read_checked(path: Path, fd: int) -> str:
    """The checks on the open descriptor, in mcp-ts's order (regular file, size, owner and mode),
    then the capped read. The caller closes ``fd``."""
    st = os.fstat(fd)
    if not stat.S_ISREG(st.st_mode):
        raise ValueError(f"yea(): refusing the server key: {path} is not a regular file")
    if st.st_size > MAX_KEY_FILE:
        raise ValueError(f"yea(): refusing the server key: {path} is larger than 64 KiB, too big for a key file")
    if not hasattr(os, "geteuid"):  # Windows: no owner or mode bits to check; say so, as mcp-ts
        warn_once(f"warning: can't check who owns {path} or who can read it on this platform; "
                  "keep it private yourself")
    elif st.st_uid != os.geteuid():
        raise ValueError(f"yea(): refusing the server key: {path} is not owned by this user")
    elif st.st_mode & 0o077:
        raise ValueError(f"yea(): refusing the server key: {path} can be read by other users (chmod 600 it)")
    data = b""
    while len(data) <= MAX_KEY_FILE and (chunk := os.read(fd, MAX_KEY_FILE + 1 - len(data))):
        data += chunk
    if len(data) > MAX_KEY_FILE:  # it grew after the size check
        raise ValueError(f"yea(): refusing the server key: {path} is larger than 64 KiB, too big for a key file")
    return data.decode("utf-8", "replace").strip()


def load_server_key(path: str | os.PathLike[str]) -> KeyPair:
    """The server's Ed25519 key: created on first run (0600, in a 0700 directory, via a temp file
    and a link), the same one-line b64url seed as mcp-ts. A symlink, a file or directory others
    can change or read, or a file that isn't a seed is refused."""
    p = Path(path)
    make_private_dirs(p.parent)
    _check_dir(p.parent)
    if not p.exists() and not p.is_symlink():
        _create_key(p)
    seed = _read_key(p)
    if not is_b64url(seed, 32):  # 32 bytes in canonical b64url, as mcp-ts
        raise ValueError(f"yea(): {p} does not hold an Ed25519 seed")
    return KeyPair.from_seed(seed)
