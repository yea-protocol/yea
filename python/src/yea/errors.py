"""Teaching errors (SPEC §7): the error codes, ``YeaError`` and ``fix``.

Mirrors ts/src/errors.ts.
"""

from __future__ import annotations

from typing import Any

CODES = frozenset(
    {
        "bad_frame",
        "unknown_capability",
        "invalid_params",
        "unauthorized",
        "forbidden",
        "consent_required",
        "not_found",
        "expired",
        "conflict",
        "limit",
        "unavailable",
        "internal",
    }
)


class YeaError(Exception):
    """Raise from a handler to reply with ``ERROR`` (SPEC §7)."""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        fix: list[dict] | None = None,
        retry: int | None = None,
        need: list[dict] | None = None,
        consent: dict | None = None,
    ):
        if code not in CODES:
            raise ValueError(f"unknown error code {code!r}")
        super().__init__(f"{code}: {message}")
        self.code, self.message = code, message
        self.fix, self.retry, self.need, self.consent = fix, retry, need, consent

    def body(self) -> dict[str, Any]:
        b: dict[str, Any] = {"code": self.code, "message": self.message}
        for k in ("fix", "need", "consent", "retry"):
            v = getattr(self, k)
            if v is not None:
                b[k] = v
        return b


def fix(say: str, params: dict | None = None) -> dict:
    """A fix: a sentence plus an optional params merge patch expected to make the request succeed."""
    return {"say": say, "params": params} if params is not None else {"say": say}
