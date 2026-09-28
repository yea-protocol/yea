"""The phrase a person types to approve, how an answer is matched, and the printable-text rule (SPEC-approval §3)."""

from __future__ import annotations

import unicodedata
from collections.abc import Callable
from typing import Any

from ..text import printable
from .plan import HashedPlan

_STRIP = "\u0009\u000a\u000b\u000c\u000d  ﻿"


def normalize_phrase(s: str) -> str:
    """NFC, then strip exactly U+0009–000D, U+0020, U+00A0, U+FEFF at both ends, then lowercase."""
    return unicodedata.normalize("NFC", s).strip(_STRIP).lower()


def phrase_of(p: HashedPlan, phrase_for: Callable[[HashedPlan], str] | None) -> str:
    """The phrase for ``p``: the tool's, or ``approve`` when it names none. A phrase that is
    empty once normalized would let an empty field approve, so it becomes ``approve`` too."""
    phrase = phrase_for(p) if phrase_for is not None else None
    return phrase if isinstance(phrase, str) and normalize_phrase(phrase) else "approve"


def checked_phrase(phrase: str, whose: str = "the approval phrase") -> str:
    """A tool's phrase, checked before anyone is asked (§3): it must be printable text, since the
    person is shown it escaped and could never type the raw characters, so anything else is a
    developer error. ``whose`` names the phrase in the error. Then the ``approve`` fallback applies."""
    if not isinstance(phrase, str):
        raise TypeError(f"{whose} must be a string")
    if printable(phrase) != phrase:
        raise TypeError(f'{whose} has unprintable characters, so no one could type it: "{printable(phrase)}"')
    return phrase if normalize_phrase(phrase) else "approve"


def phrase_matches(typed: Any, phrase: str) -> bool:
    """Both sides normalized and equal. An empty answer never matches, even an empty phrase."""
    if not isinstance(typed, str) or not normalize_phrase(typed):
        return False
    return normalize_phrase(typed) == normalize_phrase(phrase)
