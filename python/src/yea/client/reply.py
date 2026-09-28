"""Replies as the agent sees them, and the check that drops a malformed proposal or receipt."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from ..lens import lens as render_lens
from ..risk import is_risk
from ..uses import is_uses

OnEvent = Callable[["Reply"], Any]


class Reply:
    """A reply frame. Body fields are attributes (``r.data``, ``r.proposals``…);
    ``r.lens`` is the reply's Lens as the service sent it (or rendered from it); to show a
    service's reply to a person or a model safely, use ``untrusted_lens(r.frame)`` (``from yea.lens import
    untrusted_lens``)."""

    def __init__(self, frame: dict, events: list[Reply] | None = None):
        self.frame = frame
        self.events = events or []

    @property
    def kind(self) -> str:
        return self.frame.get("kind", "")

    @property
    def ok(self) -> bool:
        return self.kind != "ERROR"

    @property
    def lens(self) -> str:
        own = self.frame.get("lens")
        return own if isinstance(own, str) else render_lens(self.frame)

    def __getattr__(self, name: str) -> Any:
        try:
            return self.__dict__["frame"][name]
        except KeyError:
            raise AttributeError(name) from None

    def __getitem__(self, name: str) -> Any:
        return self.frame[name]

    def get(self, name: str, default: Any = None) -> Any:
        return self.frame.get(name, default)

    def __repr__(self) -> str:
        return f"Reply({self.kind})"

    def __str__(self) -> str:
        return self.lens


def _checked_reply(r: Reply) -> Reply:
    """A proposal or receipt with a malformed ``uses`` makes the whole reply invalid (SPEC §5.1)."""
    f = r.frame
    items = f.get("proposals") if f.get("kind") == "PROPOSALS" else [f.get("receipt")] if f.get("kind") == "RECEIPT" else []
    for item in items if isinstance(items, list) else []:
        why = _malformed_part(item, f["kind"] == "PROPOSALS")
        if why:
            what = "proposal" if f["kind"] == "PROPOSALS" else "receipt"
            err = {"yea": 1, "id": f.get("id", ""), "re": f.get("re", ""), "kind": "ERROR", "code": "bad_frame",
                   "message": f"{what} {item.get('id', '?')} from the service has {why}, so it was ignored"}
            return Reply(err, r.events)
    return r


def _malformed_part(item: Any, is_proposal: bool) -> str | None:
    """What makes a proposal or receipt invalid (SPEC §5.1), or None."""
    if not isinstance(item, dict):
        return None
    if "uses" in item and not is_uses(item["uses"]):
        return "a malformed uses"
    if is_proposal and not is_risk(item.get("risk")):  # only a proposal carries a risk
        return "an unknown risk"
    return None
