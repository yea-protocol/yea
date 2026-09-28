"""Showing untrusted text to a person or a model (the approval form, a job's plans, a consent).

Text from a service or a consent code is untrusted: control characters could rewrite what the
person reads before approving, and invisible ones could make two targets look the same or
smuggle text to a model, so they're shown as escapes. Mirrors ts/src/text.ts."""

from __future__ import annotations

import unicodedata
from typing import Any

# Default_Ignorable_Code_Point (Unicode DerivedCoreProperties) that aren't already in Cc/Cf/Zl/Zp.
# The standard library has no \p{…} classes, so the property is listed as ranges.
_IGNORABLE = (
    (0x00AD, 0x00AD), (0x034F, 0x034F), (0x061C, 0x061C), (0x115F, 0x1160), (0x17B4, 0x17B5),
    (0x180B, 0x180F), (0x200B, 0x200F), (0x202A, 0x202E), (0x2060, 0x206F), (0x3164, 0x3164),
    (0xFE00, 0xFE0F), (0xFEFF, 0xFEFF), (0xFFA0, 0xFFA0), (0xFFF0, 0xFFF8), (0x1BCA0, 0x1BCA3),
    (0x1D173, 0x1D17A), (0xE0000, 0xE0FFF),
)
_UNSAFE_CATEGORIES = frozenset({"Cc", "Cf", "Zl", "Zp"})


def _keep(cp: int) -> bool:
    """Tab, and variation selectors U+FE00–FE0F, which ordinary emoji use."""
    return cp == 0x09 or 0xFE00 <= cp <= 0xFE0F


def is_unsafe(c: str) -> bool:
    """Control, format, separator and default-ignorable code points, except tab and U+FE00–FE0F.

    That takes in C0, DEL and C1; bidi marks and overrides; zero-width space and joiners, word
    joiner, BOM and soft hyphen; tag characters and variation selectors 17–256 (U+E0000–E0FFF);
    line and paragraph separators; and fillers that draw nothing (the Hangul fillers, U+034F,
    U+17B4–17B5). The Braille blank U+2800 isn't in the set: it shows as a blank cell."""
    cp = ord(c)
    if _keep(cp):
        return False
    if unicodedata.category(c) in _UNSAFE_CATEGORIES:
        return True
    return any(lo <= cp <= hi for lo, hi in _IGNORABLE)


def escape_unsafe(s: str, esc: Any) -> str:
    """``s`` with each unsafe code point replaced by ``esc(c)``."""
    return "".join(esc(c) if is_unsafe(c) else c for c in s)


def printable(s: str) -> str:
    """One line of untrusted text, each unsafe character shown as ``\\u{hex}``. A newline inside
    it is escaped, so it can't add fake lines."""
    return escape_unsafe(s, lambda c: f"\\u{{{ord(c):x}}}")


def json_printable(json_text: str) -> str:
    """JSON text with the characters ``printable`` escapes written as ``\\uXXXX`` (per UTF-16 code
    unit), so it's still JSON. A raw newline between lines is the pretty-printer's and stays."""

    def esc(c: str) -> str:
        units = c.encode("utf-16-be")
        return "".join(f"\\u{int.from_bytes(units[i:i + 2], 'big'):04x}" for i in range(0, len(units), 2))

    return "\n".join(escape_unsafe(line, esc) for line in json_text.split("\n"))


def clip(s: str, max_len: int) -> str:
    """``s`` cut to ``max_len`` code points, the last one ``…`` when cut; nothing below 1."""
    if max_len < 1:
        return ""
    return s[: max_len - 1] + "…" if len(s) > max_len else s


def one_line(v: Any) -> Any:
    """``v`` with every string (and key) made one line by ``printable``, for showing a service's
    fields without letting a summary forge a line."""
    if isinstance(v, str):
        return printable(v)
    if isinstance(v, list):
        return [one_line(x) for x in v]
    if isinstance(v, dict):
        return {printable(k) if isinstance(k, str) else k: one_line(x) for k, x in v.items()}
    return v
