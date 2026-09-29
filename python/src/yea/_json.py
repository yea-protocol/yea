"""JSON encodings shared by every part of the implementation.

- ``canonical`` (SPEC §10): sorted keys, no whitespace, integers only. Used for hashing/signing.
- ``compact``: insertion-order, no whitespace, JavaScript number formatting. This is what
  ``JSON.stringify`` produces, and it is what Lens embeds when it falls back to JSON.
- ``b64url``: base64url without padding (SPEC §6.1).
"""

from __future__ import annotations

import base64
import hashlib
import json
import math
import re
from decimal import Decimal
from typing import Any

MAX_SAFE_INT = 2**53 - 1

_SURROGATE = re.compile("[\ud800-\udfff]")

_ESCAPES = {'"': '\\"', "\\": "\\\\", "\b": "\\b", "\f": "\\f", "\n": "\\n", "\r": "\\r", "\t": "\\t"}


class CanonicalError(ValueError):
    """Raised when a value cannot be canonicalized (floats, unsafe ints, bad types)."""


def quote(s: str) -> str:
    """JSON-quote a string the way SPEC §10 (and well-formed JSON.stringify) does."""
    out = ['"']
    for ch in s:
        esc = _ESCAPES.get(ch)
        if esc is not None:
            out.append(esc)
        elif ch < " " or "\ud800" <= ch <= "\udfff":
            # Control characters, and lone surrogates (which cannot be UTF-8 encoded).
            out.append("\\u%04x" % ord(ch))
        else:
            out.append(ch)
    out.append('"')
    return "".join(out)


def js_number(x: int | float) -> str:
    """Format a number exactly like ECMAScript ``Number.prototype.toString``."""
    if isinstance(x, bool):
        raise TypeError("bool is not a number")
    if isinstance(x, int):
        return str(x)
    if math.isnan(x) or math.isinf(x):
        return "null"  # what JSON.stringify emits
    if x == 0:
        return "0"
    sign = "-" if x < 0 else ""
    # repr() yields the shortest round-tripping digits, the same digits ECMAScript uses.
    _, digit_tuple, exp = Decimal(repr(abs(x))).as_tuple()
    raw = "".join(map(str, digit_tuple))
    digits = raw.rstrip("0")
    exp += len(raw) - len(digits)
    k = len(digits)
    n = k + exp  # value = 0.digits × 10^n
    if k <= n <= 21:
        body = digits + "0" * (n - k)
    elif 0 < n <= 21:
        body = digits[:n] + "." + digits[n:]
    elif -6 < n <= 0:
        body = "0." + "0" * (-n) + digits
    else:
        e = n - 1
        esign = "+" if e >= 0 else "-"
        mant = digits if k == 1 else digits[0] + "." + digits[1:]
        body = f"{mant}e{esign}{abs(e)}"
    return sign + body


_INDEX = re.compile(r"0|[1-9][0-9]*")
_MAX_INDEX = 2**32 - 2


def _index(k: Any) -> int | None:
    """``k`` as an ECMAScript array index ("0" to "4294967294", no sign or leading zero), else None.
    The length is checked first: ``int()`` of a hostile key thousands of digits long would raise."""
    s = str(k)
    return int(s) if len(s) <= 10 and _INDEX.fullmatch(s) and int(s) <= _MAX_INDEX else None


def js_keys(obj: dict) -> list:
    """``obj``'s keys in ECMAScript property order, as ``Object.keys`` and ``JSON.stringify`` give
    them (SPEC §9.1): array-index keys first in ascending numeric order, then the rest in
    insertion order."""
    indexed, rest = [], []
    for k in obj:
        i = _index(k)
        (rest if i is None else indexed).append((i, k))
    indexed.sort(key=lambda ik: ik[0])  # by index alone: 1 and "1" can't be compared
    return [k for _, k in indexed] + [k for _, k in rest]


def compact(v: Any) -> str:
    """Serialize like ``JSON.stringify(v)``: keys in ECMAScript order (``js_keys``), no whitespace."""
    if v is None:
        return "null"
    if v is True:
        return "true"
    if v is False:
        return "false"
    if isinstance(v, (int, float)):
        return js_number(v)
    if isinstance(v, str):
        return quote(v)
    if isinstance(v, dict):
        return "{" + ",".join(quote(str(k)) + ":" + compact(v[k]) for k in js_keys(v)) + "}"
    if isinstance(v, (list, tuple)):
        return "[" + ",".join(compact(x) for x in v) + "]"
    raise TypeError(f"not JSON-serializable: {type(v).__name__}")


def canonical(v: Any) -> str:
    """Canonical JSON (SPEC §10) as a str. Raises CanonicalError on non-integers."""
    if v is None:
        return "null"
    if v is True:
        return "true"
    if v is False:
        return "false"
    if isinstance(v, int):
        if abs(v) > MAX_SAFE_INT:
            raise CanonicalError(f"integer out of safe range: {v}")
        return str(v)
    if isinstance(v, float):
        # A JSON "1.0" parses to 1.0 in Python but to the integer 1 in JavaScript; accept it.
        if v.is_integer() and abs(v) <= MAX_SAFE_INT:
            return str(int(v))
        raise CanonicalError(f"only integers are allowed in canonical JSON (got {v!r})")
    if isinstance(v, str):
        return quote(_well_formed(v))
    if isinstance(v, dict):
        for k in v:
            if not isinstance(k, str):
                raise CanonicalError("object keys must be strings")
        joined = {_well_formed(k): x for k, x in v.items()}
        if len(joined) != len(v):
            # "\ud83c\udf89" and "🎉" are one key once the pair is joined, as JavaScript reads it.
            raise CanonicalError("two keys are the same once surrogate pairs are joined")
        v = joined
        # Sort by code point. Python compares str by code point, unlike JS's UTF-16 sort,
        # but the two agree for all BMP keys (and keys SHOULD be ASCII).
        return "{" + ",".join(quote(k) + ":" + canonical(v[k]) for k in sorted(v)) + "}"
    if isinstance(v, (list, tuple)):
        return "[" + ",".join(canonical(x) for x in v) + "]"
    raise CanonicalError(f"not JSON-serializable: {type(v).__name__}")


def _well_formed(s: str) -> str:
    """``s`` with any surrogate pair joined into its character, as JavaScript reads it. A lone
    surrogate has no UTF-8 encoding, so it has no canonical form (SPEC §10)."""
    if not _SURROGATE.search(s):
        return s
    joined = s.encode("utf-16-le", "surrogatepass").decode("utf-16-le", "surrogatepass")
    lone = _SURROGATE.search(joined)
    if lone is not None:
        raise CanonicalError(f"a lone surrogate (U+{ord(lone.group()):04X}) has no canonical form")
    return joined


def has_lone_surrogate(v: Any) -> bool:
    """Whether any string or key in ``v`` holds a lone surrogate, so ``v`` has no canonical form
    (SPEC §10). It walks with its own stack, so a deeply nested frame can't hit the recursion limit."""
    todo = [v]
    while todo:
        x = todo.pop()
        if isinstance(x, dict):
            todo.extend(x.keys())
            todo.extend(x.values())
        elif isinstance(x, (list, tuple)):
            todo.extend(x)
        elif isinstance(x, str) and _SURROGATE.search(x):
            try:
                _well_formed(x)
            except CanonicalError:
                return True
    return False


def canonical_bytes(v: Any) -> bytes:
    return canonical(v).encode("utf-8")


def b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


_B64URL = re.compile(r"[A-Za-z0-9_-]*")


def b64url_decode(s: str) -> bytes:
    """Decode canonical base64url (SPEC §6.1): the alphabet only, no padding, and the unused bits
    of the last character zero, so every byte string has exactly one encoding. Anything else
    raises ValueError."""
    if not isinstance(s, str) or not _B64URL.fullmatch(s) or len(s) % 4 == 1:
        raise ValueError("invalid base64url")
    out = base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))
    if b64url_encode(out) != s:
        raise ValueError("non-canonical base64url")
    return out


def is_b64url(s: Any, nbytes: int | None = None) -> bool:
    """Whether ``s`` is canonical base64url (see ``b64url_decode``), of exactly ``nbytes`` bytes if given."""
    try:
        raw = b64url_decode(s)
    except ValueError:
        return False
    return nbytes is None or len(raw) == nbytes


def sha256_b64url(data: bytes) -> str:
    return b64url_encode(hashlib.sha256(data).digest())


def proposal_hash(proposal: dict) -> str:
    """``b64url(sha256(canonical(proposal without "hash" and "data")))`` (SPEC §5.1)."""
    body = {k: v for k, v in proposal.items() if k not in ("hash", "data")}
    return sha256_b64url(canonical_bytes(body))


def dumps(frame: Any) -> str:
    """Wire serialization for a frame: one line, UTF-8, no literal newlines."""
    return json.dumps(frame, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def loads(text: str | bytes) -> Any:
    return json.loads(text)
