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
from decimal import Decimal
from typing import Any

MAX_SAFE_INT = 2**53 - 1

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


def compact(v: Any) -> str:
    """Serialize like ``JSON.stringify(v)``: insertion order, no whitespace."""
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
        return "{" + ",".join(quote(str(k)) + ":" + compact(val) for k, val in v.items()) + "}"
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
        v = {_well_formed(k): x for k, x in v.items()}
        # Sort by code point. Python compares str by code point, unlike JS's UTF-16 sort,
        # but the two agree for all BMP keys (and keys SHOULD be ASCII).
        return "{" + ",".join(quote(k) + ":" + canonical(v[k]) for k in sorted(v)) + "}"
    if isinstance(v, (list, tuple)):
        return "[" + ",".join(canonical(x) for x in v) + "]"
    raise CanonicalError(f"not JSON-serializable: {type(v).__name__}")


def _well_formed(s: str) -> str:
    """``s`` with any surrogate pair joined into its character, as JavaScript reads it. A lone
    surrogate has no UTF-8 encoding, so it has no canonical form (SPEC §10)."""
    if not any("\ud800" <= ch <= "\udfff" for ch in s):
        return s
    joined = s.encode("utf-16-le", "surrogatepass").decode("utf-16-le", "surrogatepass")
    lone = next((ch for ch in joined if "\ud800" <= ch <= "\udfff"), None)
    if lone is not None:
        raise CanonicalError(f"a lone surrogate (U+{ord(lone):04X}) has no canonical form")
    return joined


def canonical_bytes(v: Any) -> bytes:
    return canonical(v).encode("utf-8")


def b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def b64url_decode(s: str) -> bytes:
    if not isinstance(s, str) or "=" in s:
        raise ValueError("b64url must be an unpadded string")
    try:
        return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))
    except Exception as e:  # binascii.Error
        raise ValueError(f"invalid b64url: {e}") from None


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
