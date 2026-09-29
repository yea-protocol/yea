"""A service's registered capabilities: the list HELLO shows, and the error for a name that isn't
one (like ts/src/service/capabilities.ts)."""

from __future__ import annotations

from typing import Any

from ..errors import YeaError, fix
from ..validate import closest
from .state import ServiceState
from .util import _json_str


def list_capabilities(state: ServiceState) -> list[dict]:
    """Every capability, asks first, as a BRIEF lists them."""
    out: list[dict] = []
    for name, a in state.asks.items():
        out.append({"name": name, "kind": "ask", "summary": a.summary, **({"params": a.params} if a.params else {})})
    for name, i in state.intents.items():
        c: dict[str, Any] = {"name": name, "kind": "intent", "summary": i.summary}
        if i.params:
            c["params"] = i.params
        if i.risk:
            c["risk"] = i.risk
        out.append(c)
    return out


def unknown_capability(state: ServiceState, name: Any, kind: str) -> YeaError:
    """``unknown_capability``, naming the right verb or the closest name."""
    other = state.intents if kind == "ask" else state.asks
    if isinstance(name, str) and name in other:
        verb = "INTENT" if kind == "ask" else "ASK"
        return YeaError(
            "unknown_capability", f"{name} is {'an intent' if kind == 'ask' else 'an ask'} capability", fix=[fix(f"send it with {verb}")]
        )
    everything = [*state.asks, *state.intents]
    near = closest(str(name), everything)
    return YeaError(
        "unknown_capability",
        f"no capability named {_json_str(name)}",
        fix=[fix(f"did you mean {near}?")] if near else [fix(f"send HELLO to list capabilities ({len(everything)} available)")],
    )
