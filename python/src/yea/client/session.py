"""The Client: one agent's session with a service. It signs each request and attaches the grants that apply."""

from __future__ import annotations

import os
import time
from collections.abc import Sequence
from typing import Any

from .._json import b64url_encode
from ..grants import Grant, decode_grant
from ..keys import KeyPair, sign_proof
from .reply import OnEvent, Reply, _checked_reply


def _grant_services(token: str) -> list[str] | None:
    """The first ``svc`` caveat's list, or None if the grant has none. Raises on bad tokens."""
    for b in decode_grant(token).blocks:
        for c in b["p"]["caveats"]:
            if isinstance(c, dict) and "svc" in c:
                return c["svc"] if isinstance(c["svc"], list) else []
    return None


class Client:
    """A connection to one service; see :func:`connect`. Mirrors ts/src/client.ts.

    With ``key`` (a KeyPair or a b64url seed) and grants, requests other than HELLO carry
    the grants that apply to this service (no ``svc`` caveat, or one naming it) plus a
    proof. The proof audience is the service id from HELLO, sent automatically if needed.
    Every method returns a :class:`Reply`; ``reply.lens`` is what a model should read.
    """

    def __init__(
        self,
        transport: Any,
        key: KeyPair | str | bytes | None = None,
        grants: Sequence[str | Grant] = (),
        name: str = "agent",
        budget: int | None = None,
    ):
        self._t = transport
        self.key = key if isinstance(key, KeyPair) or key is None else KeyPair.from_seed(key)
        self.grants = [str(g) for g in grants]
        self.name = name
        self.budget = budget
        self.service_id: str | None = None

    async def __aenter__(self) -> Client:
        return self

    async def __aexit__(self, *exc: Any) -> None:
        await self.close()

    async def close(self) -> None:
        await self._t.close()

    def add_grant(self, token: str | Grant) -> None:
        self.grants.append(str(token))

    async def send(self, body: dict, on_event: OnEvent | None = None) -> Reply:
        """Send a request body (``yea`` and ``id`` are filled in)."""
        return _checked_reply(await self._t.request({"yea": 1, "id": _request_id(), **body}, on_event))

    async def audience(self) -> str:
        """The service's id (learned from HELLO), which proofs are bound to."""
        if self.service_id is None:
            await self.hello(200)
        return self.service_id or ""

    async def _signed(self, verb: str, target: str, extra: Sequence[str | Grant] | None = None) -> dict:
        tokens = self.grants + [str(g) for g in extra or ()]
        if self.key is None or not tokens:
            return {}
        aud = await self.audience()
        usable = []
        for t in tokens:
            try:
                svcs = _grant_services(t)
            except ValueError:
                continue
            if svcs is None or aud in svcs:
                usable.append(t)
        if not usable:
            return {}
        return {"grants": usable, "proof": sign_proof(self.key, aud, verb, target, int(time.time()))}

    def _budget(self, budget: int | None) -> dict:
        b = budget if budget is not None else self.budget
        return {"budget": b} if b else {}

    async def hello(self, budget: int | None = None) -> Reply:
        agent: dict[str, Any] = {"name": self.name}
        if self.key is not None:
            agent["key"] = self.key.public
        r = await self.send({"verb": "HELLO", "agent": agent, **self._budget(budget)})
        if r.kind == "BRIEF":
            self.service_id = r.frame["service"]["id"]
        return r

    async def ask(self, capability: str, params: dict | None = None, *, budget: int | None = None) -> Reply:
        body = {"verb": "ASK", "capability": capability, "params": params or {}, **self._budget(budget)}
        return await self.send({**body, **await self._signed("ASK", capability)})

    async def intent(
        self, capability: str, params: dict | None = None, *, goal: str | None = None, budget: int | None = None,
        auto: bool = False, on_event: OnEvent | None = None,
    ) -> Reply:
        """Express an intent. With ``auto``, the service commits the first proposal in the same
        round trip when your grants already allow it and it is undoable; you get a RECEIPT back."""
        rid = _request_id()
        body: dict[str, Any] = {"yea": 1, "id": rid, "verb": "INTENT", "capability": capability, "params": params or {}}
        if goal:
            body["goal"] = goal
        if auto:
            body["auto"] = True
        body.update(self._budget(budget))
        # Auto-commit proofs are bound to this frame id, so a captured frame can't mint new commits.
        body.update(await self._signed("INTENT", f"auto:{capability}:{rid}" if auto else capability))
        return await self._t.request(body, on_event)

    async def commit(
        self, proposal: dict, *, grants: Sequence[str | Grant] | None = None,
        on_event: OnEvent | None = None, budget: int | None = None,
    ) -> Reply:
        """Commit a proposal (anything with ``id`` and ``hash``). ``grants`` adds one-off
        grants for this call only, such as a consent grant."""
        body = {"verb": "COMMIT", "proposal": proposal["id"], "hash": proposal["hash"]}
        if budget:
            body["budget"] = budget
        return await self.send({**body, **await self._signed("COMMIT", proposal["hash"], grants)}, on_event)

    async def undo(self, receipt: str | dict, *, on_event: OnEvent | None = None) -> Reply:
        rid = receipt["id"] if isinstance(receipt, dict) else receipt
        return await self.send({"verb": "UNDO", "receipt": rid, **await self._signed("UNDO", rid)}, on_event)

    async def expand(self, handle: str | dict, *, budget: int | None = None) -> Reply:
        h = handle["handle"] if isinstance(handle, dict) else handle
        return await self.send({"verb": "EXPAND", "handle": h, **self._budget(budget), **await self._signed("EXPAND", h)})


def _request_id() -> str:
    # Random, not a counter: auto-commit dedupes on (key, frame id) across connections (§4.3.1).
    return "c_" + b64url_encode(os.urandom(9))
