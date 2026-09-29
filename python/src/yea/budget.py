"""Token budgets (SPEC §8). Replies are fitted to the agent's budget by eliding the largest
arrays/strings; elided parts are parked behind EXPAND handles. Mirrors ts/src/budget.ts."""

from __future__ import annotations

import copy
import os
import time
from typing import Any, Protocol

from ._json import b64url_encode, compact, js_keys
from .lens import est, lean, lens

MIN_STRING = 200
Path = tuple


class HandleStore(Protocol):
    def put(self, handle: str, value: list | str, owner: str | None = None) -> None: ...
    def get(self, handle: str) -> tuple[list | str, str | None] | None: ...


class MemoryHandleStore:
    """Parked remainders, kept for ``ttl`` seconds (SPEC §4.6 asks for at least 10 minutes).
    ``owner`` is the verified holder key of the request that produced the handle, if any."""

    def __init__(self, ttl: float = 30 * 60):
        self.ttl = ttl
        self._m: dict[str, tuple[list | str, str | None, float]] = {}

    def put(self, handle: str, value: list | str, owner: str | None = None) -> None:
        self._m[handle] = (value, owner, time.monotonic() + self.ttl)
        if len(self._m) > 10_000:
            now = time.monotonic()
            self._m = {k: v for k, v in self._m.items() if v[2] > now}

    def get(self, handle: str) -> tuple[list | str, str | None] | None:
        e = self._m.get(handle)
        return (e[0], e[1]) if e and e[2] > time.monotonic() else None


def _get(root: Any, path: Path) -> Any:
    for k in path:
        try:
            root = root[k]
        except (KeyError, IndexError, TypeError):
            return None
    return root


def _set(root: Any, path: Path, value: Any) -> None:
    _get(root, path[:-1])[path[-1]] = value


def _collect(v: Any, path: Path, out: list) -> None:
    if isinstance(v, str):
        if len(v) > MIN_STRING:
            out.append((path, len(v)))
    elif isinstance(v, list):
        if v:
            out.append((path, len(compact(v))))
        for i, x in enumerate(v):
            _collect(x, path + (i,), out)
    elif isinstance(v, dict):
        for k in js_keys(v):  # in Object.entries order, so a tie elides the same path as TS
            _collect(v[k], path + (k,), out)


def _roots(r: dict) -> tuple[list[Path], list[Path]]:
    """(deep roots, list roots) per SPEC §8. Deep roots may be elided anywhere inside and go
    first; list roots only lose whole trailing items, so what remains is never altered."""
    kind = r.get("kind")
    if kind == "ANSWER":
        return [("data",)], []
    if kind == "BRIEF":
        return [], [("capabilities",)]
    if kind == "PROPOSALS":
        return [("proposals", i, "data") for i, p in enumerate(r.get("proposals") or []) if "data" in p], [("proposals",)]
    if kind == "RECEIPT":
        return [("receipt", "result")], []
    return [], []


def fit(reply: dict, budget: int, store: HandleStore, owner: str | None = None) -> dict:
    """Fit ``reply`` within ``budget`` estimated tokens of Lens. Returns a new reply.
    Handles it creates are expandable only by ``owner`` when one is given (SPEC §4.6)."""
    if est(lens(reply)) <= budget:
        return reply
    original = copy.deepcopy(reply)
    r = copy.deepcopy(reply)
    cut: dict[Path, int] = {}  # path -> kept length, in elision order
    base_more = list(r.get("more") or [])
    # Real handles are picked up front: under the §8 estimate a placeholder can count as
    # fewer tokens than the random handle that replaces it, overshooting the budget.
    handles: dict[Path, str] = {}

    def more_for(real: bool) -> list[dict]:
        out = []
        for path, kept in cut.items():
            if _get(r, path) is None:
                continue  # an ancestor was elided; its remainder carries this
            rest = _get(original, path)[kept:]
            handle = handles.setdefault(path, "h_" + b64url_encode(os.urandom(9)))
            if real:
                store.put(handle, rest, owner)
            out.append({
                "handle": handle, "path": ".".join(map(str, path)), "remaining": len(rest),
                "est": est(rest) if isinstance(rest, str) else est(lean(rest)),
            })
        return out

    for _ in range(200):
        more = base_more + more_for(False)
        view = {**r, "more": more} if more else r
        if est(lens(view)) <= budget:
            break
        deep, lists = _roots(r)
        cands: list = []
        for root in deep:
            v = _get(r, root)
            if v is not None:
                _collect(v, root, cands)
        if not cands:
            cands = [(root, len(compact(v))) for root in lists if isinstance(v := _get(r, root), list) and v]
        if not cands:
            break
        path = max(cands, key=lambda c: c[1])[0]  # first of the largest, like the TS reduce
        cur = _get(r, path)
        if isinstance(cur, str):
            already = path in cut
            body = cur[:-1] if already else cur  # strip our "…"
            kept = max(MIN_STRING, len(body) // 2)
            if kept >= len(body):
                break
            cut[path] = min(cut[path], kept) if already else kept
            _set(r, path, body[:kept] + "…")
        else:
            cut[path] = len(cur) // 2 if path not in cut else min(cut[path], len(cur) // 2)
            _set(r, path, cur[: len(cur) // 2])
    more = base_more + more_for(True)
    if more:
        r["more"] = more
    return r
