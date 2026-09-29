"""What a job server trusts besides its own key (SPEC-approval §2): the pinned principal key, the
signed policy grant and the unsigned tightening. The policy and tightening are read on every
call, so a new grant applies without a restart; the principal key is read once."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from yea import decode_grant
from yea.approval import RISK_ORDER, Tightening, load_principal_key, read_tightening
from yea.keys import is_public_key
from yea.store.files import yea_home

from .util import warn_once


@dataclass(frozen=True)
class Pinned:
    """The pinned principal key, or why there is none (then nothing auto-runs, no consent counts)."""

    key: str | None = None
    why: str | None = None


def pinned_principal(option: str | None) -> Pinned:
    """The option if given (taken as the author's code gives it), else ``YEA_PRINCIPAL_PUB``, checked."""
    if option is not None:
        if is_public_key(option):
            return Pinned(key=option)
        return Pinned(why="the principal option is not an ed25519 public key")
    path = os.environ.get("YEA_PRINCIPAL_PUB")
    if not path:
        return Pinned(why="YEA_PRINCIPAL_PUB is not set")
    try:
        return Pinned(key=load_principal_key(path))
    except ValueError as e:
        return Pinned(why=str(e))


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
    path = yea_home() / "policy.json"
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
