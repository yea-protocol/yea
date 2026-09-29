"""The pinned principal key file: refused unless it is out of the server user's reach (SPEC-approval §2)."""

from __future__ import annotations

import os
import stat
from pathlib import Path

from ..keys import parse_public_key


def check_key_file(path: str | os.PathLike[str]) -> str | None:
    """Why the pinned principal key file can't be trusted, or None. It is refused if the file, any
    symlink on the way to it, or any directory above one of them is owned by, or writable by,
    this process's user: any of those would let an agent running as it swap in its own key."""
    if not hasattr(os, "geteuid") or os.geteuid() == 0:
        return "the server runs as root (or can't tell its user), so no key file is out of its reach"
    try:
        visited, real = _resolve_links(Path(os.path.abspath(path)))
        if not stat.S_ISREG(real.stat().st_mode):
            return f"the principal key file {path} isn't a regular file"
    except OSError as e:
        return f"can't read the principal key file {path}: {e.strerror or e}"
    for q in dict.fromkeys(x for v in (*visited, real) for x in (v, *v.parents)):
        why = _reachable(q)
        if why:
            return why
    return None


def load_principal_key(path: str | os.PathLike[str]) -> str:
    """The pinned principal public key, read only after ``check_key_file`` passes. Once the whole
    chain is out of this user's reach it can't be swapped, and the opened file is checked again
    with ``fstat``. Raises ValueError with the reason when the key can't be trusted."""
    why = check_key_file(path)
    if why:
        raise ValueError(why)
    _, real = _resolve_links(Path(os.path.abspath(path)))
    fd = os.open(real, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    with os.fdopen(fd, encoding="utf-8") as f:
        st = os.fstat(f.fileno())
        if st.st_uid == os.geteuid() or _writable_by_us(st.st_gid, st.st_mode):
            raise ValueError(f"{real} changed while it was being read")
        key = f.read().strip()
    parse_public_key(key)
    return key


def _writable_by_us(gid: int, mode: int) -> bool:
    """World-writable, or group-writable by a group this process is in."""
    in_group = gid == os.getegid() or gid in os.getgroups()
    return bool(mode & stat.S_IWOTH) or (bool(mode & stat.S_IWGRP) and in_group)


def _resolve_links(p: Path, hops: int = 0) -> tuple[list[Path], Path]:
    """Resolve ``p`` one symlink at a time. Returns every path visited (links included) and the
    real path it ends at. Each step starts from an already-real directory."""
    visited: list[Path] = []
    cur, rest = Path(p.anchor), list(p.parts[1:])
    while rest:
        part = rest.pop(0)
        if part in ("", "."):
            continue
        if part == "..":
            cur = cur.parent
            continue
        nxt = cur / part
        visited.append(nxt)
        if not nxt.is_symlink():
            cur = nxt
            continue
        hops += 1
        if hops > 40:
            raise OSError(40, "too many levels of symbolic links", str(p))
        target = Path(os.readlink(nxt))
        if target.is_absolute():
            cur = Path(target.anchor)
        rest = list(target.parts[1:] if target.is_absolute() else target.parts) + rest
    return visited, cur


def _reachable(q: Path) -> str | None:
    st = q.lstat()
    if st.st_uid == os.geteuid():
        return f"{q} is owned by this server's user, so an agent running as it could change the principal key"
    if stat.S_ISLNK(st.st_mode):
        return None  # a link's own mode means nothing; its directory and its target are checked
    if _writable(q, st):
        return f"{q} is writable by this server's user, so an agent running as it could change the principal key"
    return None


def _writable(q: Path, st: os.stat_result) -> bool:
    effective = os.access in os.supports_effective_ids
    return os.access(q, os.W_OK, effective_ids=effective) or bool(st.st_mode & stat.S_IWOTH)
