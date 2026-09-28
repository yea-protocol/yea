"""Lens for untrusted text: a service's reply or effect re-rendered from its fields made one line, so its
text can't forge a line or hide characters (mirrors ts/src/lens/untrusted.ts)."""

from __future__ import annotations

from typing import Any

from .format import effect_line
from .render import lens


def safe_effect_line(e: dict) -> str:
    """An effect line for a person or a model: its fields made one line first (``from``/``to`` are
    quoted by Lens itself), then the whole line through ``printable`` for what quotes leave."""
    from ..text import one_line, printable

    safe = {**one_line(e), **{k: e[k] for k in ("from", "to") if k in e}} if isinstance(e, dict) else e
    return printable(effect_line(safe))


def _keep_quoted(orig: Any, safe: Any, keys: list[str]) -> Any:
    """``safe`` (``orig`` after ``one_line``) with ``keys`` put back from ``orig``, and each of its
    ``effects``' ``from`` and ``to``: values Lens quotes itself."""
    if not isinstance(orig, dict) or not isinstance(safe, dict):
        return safe
    out = {**safe, **{k: orig[k] for k in keys if k in orig}}
    if isinstance(orig.get("effects"), list) and isinstance(safe.get("effects"), list):
        out["effects"] = [_keep_quoted(o, s, ["from", "to"]) for o, s in zip(orig["effects"], safe["effects"])]
    return out


def _quoted_back(r: dict, safe: Any) -> Any:
    """``safe`` with the values Lens renders quoted put back: an ANSWER's ``data``, a proposal's
    ``data``, a receipt's ``result``, and effects' ``from`` and ``to``."""
    if not isinstance(safe, dict):
        return safe
    kind = r.get("kind")
    if kind == "ANSWER":
        return _keep_quoted(r, safe, ["data"])
    if kind == "PROPOSALS" and isinstance(safe.get("proposals"), list):
        return {**safe, "proposals": [_keep_quoted(o, s, ["data"]) for o, s in zip(r.get("proposals") or [], safe["proposals"])]}
    if kind == "RECEIPT":
        return {**safe, "receipt": _keep_quoted(r.get("receipt"), safe.get("receipt"), ["result"])}
    return safe


def untrusted_lens(reply: dict) -> str:
    """A service's reply as Lens, for a model or a person: re-rendered from its fields after
    ``one_line``, never the service's own ``lens``, so every line break is ours. Quoted values
    escape only C0, so each line then goes through ``printable``."""
    from ..text import one_line, printable

    rest = {k: v for k, v in reply.items() if k != "lens"}
    return "\n".join(printable(line) for line in lens(_quoted_back(reply, one_line(rest))).split("\n"))
