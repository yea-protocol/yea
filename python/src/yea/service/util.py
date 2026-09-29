"""Small helpers the service modules share: the EVENT callback type, ids, calling sync or async handlers, and
formatting."""

from __future__ import annotations

import inspect
import os
from collections.abc import Callable
from datetime import datetime, timezone
from typing import Any

from .._json import b64url_encode, compact

Emit = Callable[[dict], None]
DAY = 86400


def random_id(prefix: str, nbytes: int = 6) -> str:
    return f"{prefix}_{b64url_encode(os.urandom(nbytes))}"


async def _call(fn: Callable, *args: Any) -> Any:
    r = fn(*args)
    return await r if inspect.isawaitable(r) else r


def _json_str(v: Any) -> str:
    try:
        return compact(v)
    except TypeError:
        return repr(v)


def _iso(t: int) -> str:
    return datetime.fromtimestamp(t, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
