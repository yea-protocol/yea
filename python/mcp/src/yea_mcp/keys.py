"""What a job server trusts, and where it comes from (SPEC-mcp-py ``yea()``, SPEC-approval §2):
the server's own key, the pinned principal key, the signed policy grant and the unsigned
tightening. The policy and tightening are read on every call, so a new grant applies without a
restart; the keys are read once."""

from __future__ import annotations

import json
import os
import re
import secrets
import stat
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from yea import KeyPair, decode_grant
from yea._json import b64url_encode
from yea.approval import RISK_ORDER, Tightening, load_principal_key, read_tightening

NAME = re.compile(r"[a-z0-9._-]{1,64}")
SEED = re.compile(r"[A-Za-z0-9_-]{43}")
PUBLIC_KEY = re.compile(r"ed25519:[A-Za-z0-9_-]{43}")


def home() -> Path:
    """``$YEA_HOME``, else ``~/.yea``."""
    env = os.environ.get("YEA_HOME")
    return Path(env) if env else Path.home() / ".yea"


def check_name(name: Any) -> str:
    """Server names name a key file and appear in consent codes."""
    if not isinstance(name, str) or not NAME.fullmatch(name):
        raise ValueError(f"yea(): name must match [a-z0-9._-]{{1,64}}, got {name!r}")
    return name


def default_key_path(name: str) -> Path:
    return home() / "server" / f"{name}.key"


def _check_dir(d: Path) -> None:
    """The key's directory is this user's and writable by no one else; its parent is this user's or
    root's, and not writable by others unless sticky (like /tmp)."""
    if not hasattr(os, "geteuid"):
        return  # no POSIX owners (Windows): as mcp-ts, only the file checks apply
    st = d.lstat()
    if stat.S_ISLNK(st.st_mode) or not stat.S_ISDIR(st.st_mode) or st.st_uid != os.geteuid() or st.st_mode & 0o022:
        raise ValueError(f"yea(): refusing the server key: {d} must be a directory owned by this user, "
                         "writable by no one else")
    p = d.parent.stat()
    if p.st_uid not in (os.geteuid(), 0) or (p.st_mode & 0o002 and not p.st_mode & stat.S_ISVTX):
        raise ValueError(f"yea(): refusing the server key: {d.parent} can be changed by other users")


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
    st = os.fstat(fd)  # on the descriptor, before wrapping it: a directory can't be wrapped for reading
    if not stat.S_ISREG(st.st_mode):
        os.close(fd)
        raise ValueError(f"yea(): refusing the server key: {path} is not a regular file")
    with os.fdopen(fd, "rb") as f:
        if not hasattr(os, "geteuid"):  # Windows: no owner or mode bits to check; say so, as mcp-ts
            warn_once(f"warning: can't check who owns {path} or who can read it on this platform; "
                      "keep it private yourself")
        elif st.st_uid != os.geteuid():
            raise ValueError(f"yea(): refusing the server key: {path} is not owned by this user")
        if sys.platform != "win32" and st.st_mode & 0o077:
            raise ValueError(f"yea(): refusing the server key: {path} can be read by other users (chmod 600 it)")
        data = f.read(MAX_KEY_FILE + 1)
        if st.st_size > MAX_KEY_FILE or len(data) > MAX_KEY_FILE:
            raise ValueError(f"yea(): refusing the server key: {path} is larger than 64 KiB, too big for a key file")
        return data.decode("utf-8", "replace").strip()


def load_server_key(path: str | os.PathLike[str]) -> KeyPair:
    """The server's Ed25519 key: created on first run (0600, in a 0700 directory, via a temp file
    and a link), the same one-line b64url seed as mcp-ts. A symlink, a file or directory others
    can change or read, or a file that isn't a seed is refused."""
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    _check_dir(p.parent)
    if not p.exists() and not p.is_symlink():
        _create_key(p)
    seed = _read_key(p)
    if not SEED.fullmatch(seed):
        raise ValueError(f"yea(): {p} does not hold an Ed25519 seed")
    return KeyPair.from_seed(seed)


@dataclass(frozen=True)
class Pinned:
    """The pinned principal key, or why there is none (then nothing auto-runs, no consent counts)."""

    key: str | None = None
    why: str | None = None


def pinned_principal(option: str | None) -> Pinned:
    """The option if given (taken as the author's code gives it), else ``YEA_PRINCIPAL_PUB``, checked."""
    if option is not None:
        if PUBLIC_KEY.fullmatch(option):
            return Pinned(key=option)
        return Pinned(why="the principal option is not an ed25519 public key")
    path = os.environ.get("YEA_PRINCIPAL_PUB")
    if not path:
        return Pinned(why="YEA_PRINCIPAL_PUB is not set")
    try:
        return Pinned(key=load_principal_key(path))
    except ValueError as e:
        return Pinned(why=str(e))


_warned: set[str] = set()


def warn_once(message: str) -> None:
    """Warn on stderr once per message, so a per-call read doesn't flood the log."""
    if message not in _warned:
        _warned.add(message)
        print(f"yea: {message}", file=sys.stderr)


def _read_if_there(path: Path) -> str | None:
    try:
        return path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None
    except OSError as e:
        warn_once(f"can't read {path}: {e}")
        return None


def read_policy(option: str | None) -> str | None:
    """The signed policy grant for this call: the option, else ``YEA_POLICY``. A value starting
    with ``pg1.`` is the token; anything else is a path to one. None means nothing auto-runs."""
    value = option if option is not None else os.environ.get("YEA_POLICY")
    if not value:
        return None
    if value.startswith("pg1."):
        return value
    text = _read_if_there(Path(value))
    token = text.strip() if text is not None else None
    if not token or not token.startswith("pg1."):
        warn_once(f"{value} does not hold a pg1. policy grant; nothing auto-runs")
        return None
    return token


@dataclass(frozen=True)
class Rules:
    """Unsigned tightening as a call applies it; ``broken`` says why job calls must refuse."""

    deny: tuple[str, ...]
    out_of_band: str
    broken: str | None = None


def _no_constants(name: str) -> Any:
    """NaN and Infinity aren't JSON (TS's JSON.parse refuses them); Python's parser would accept them."""
    raise ValueError(f"{name} is not JSON")


def _parse_tightening(path: Path, text: str) -> Tightening | str:
    """The unsigned rules in a policy file, or why the file can't be used."""
    try:
        doc = json.loads(text, parse_constant=_no_constants)
    except ValueError:
        return f"{path} is not valid JSON"
    if not isinstance(doc, dict):  # null too, as TS: an object is the only valid policy
        return f"{path}: the policy file is not a JSON object; ignored"
    t = read_tightening(doc)
    # Unknown fields only warn; a file we can't read, or a bad deny or outOfBand, fails closed.
    bad = next((w for w in t.warnings if "not a JSON object" in w or "bad value" in w), None)
    return f"{path}: {bad}" if bad else t


def _file_tightening() -> Tightening | str | None:
    """The unsigned rules in ``~/.yea/policy.json``: None when there's no file, a reason string
    when it can't be used. Its ``deny`` can't be known then, so job calls refuse."""
    path = home() / "policy.json"
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None
    except (OSError, UnicodeDecodeError) as e:
        return f"can't read {path}: {e}"
    return _parse_tightening(path, text)


def read_tightening_for(option: Any) -> Rules:
    """The option and ``~/.yea/policy.json`` merged: ``deny`` is the union, ``outOfBand`` the stricter."""
    from_file = _file_tightening()
    parts = [read_tightening(option or {}), *([from_file] if isinstance(from_file, Tightening) else [])]
    for w in (w for t in parts for w in t.warnings):
        warn_once(f"policy: {w}")
    deny = tuple(dict.fromkeys(d for t in parts for d in t.deny))
    oob = min((t.out_of_band for t in parts), key=lambda r: RISK_ORDER[r])
    return Rules(deny, oob, from_file if isinstance(from_file, str) else None)


def has_total(grant: str) -> bool:
    """Whether a policy grant has a ``total`` limit (a MemoryStore shared by processes can't keep one)."""
    try:
        g = decode_grant(grant)
    except ValueError:
        return False  # the grant check says why it's unusable
    return any(isinstance(c, dict) and "total" in c for b in g.blocks for c in b["p"]["caveats"])
