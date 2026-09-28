"""The agent side: connect to a service and speak YEA."""

from __future__ import annotations

import asyncio
import os
import shlex
import ssl
import time
import urllib.request
from collections.abc import Callable, Sequence
from typing import Any
from urllib.parse import urlsplit

from ._json import b64url_encode, dumps, loads
from .grants import Grant, decode_grant
from .keys import KeyPair, sign_proof
from .lens import lens as render_lens
from .transport import DEFAULT_PORT, MAX_FRAME, TLS_PORT
from .uses import is_uses
OnEvent = Callable[["Reply"], Any]


class Reply:
    """A reply frame. Body fields are attributes (``r.data``, ``r.proposals``…);
    ``r.lens`` is the reply's Lens as the service sent it (or rendered from it); to show a
    service's reply to a person or a model safely, use ``yea.lens.untrusted_lens(r.frame)``."""

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
        if isinstance(item, dict) and "uses" in item and not is_uses(item["uses"]):
            what = "proposal" if f["kind"] == "PROPOSALS" else "receipt"
            err = {"yea": 1, "id": f.get("id", ""), "re": f.get("re", ""), "kind": "ERROR", "code": "bad_frame",
                   "message": f"{what} {item.get('id', '?')} has a malformed uses"}
            return Reply(err, r.events)
    return r


# ------------------------------------------------------------ transports


class _StreamTransport:
    def __init__(self, reader: asyncio.StreamReader, writer: Any, proc: Any = None):
        self.reader, self.writer, self.proc = reader, writer, proc
        self.pending: dict[str, tuple[asyncio.Future, list, OnEvent | None]] = {}
        self.task = asyncio.create_task(self._read())

    async def _read(self) -> None:
        err: BaseException = ConnectionError("connection closed")
        try:
            while True:
                line = await self.reader.readline()
                if not line:
                    break
                if not line.strip():
                    continue
                frame = loads(line)
                entry = self.pending.get(frame.get("re")) if isinstance(frame, dict) else None
                if entry is None:
                    continue
                fut, events, on_event = entry
                if frame.get("kind") == "EVENT":
                    ev = Reply(frame)
                    events.append(ev)
                    if on_event:
                        r = on_event(ev)
                        if asyncio.iscoroutine(r):
                            await r
                else:
                    self.pending.pop(frame["re"], None)
                    if not fut.done():
                        fut.set_result(Reply(frame, events))
        except Exception as e:  # malformed stream
            err = e
        for fut, _, _ in self.pending.values():
            if not fut.done():
                fut.set_exception(err)
        self.pending.clear()

    async def request(self, frame: dict, on_event: OnEvent | None) -> Reply:
        fut = asyncio.get_running_loop().create_future()
        self.pending[frame["id"]] = (fut, [], on_event)
        self.writer.write((dumps(frame) + "\n").encode("utf-8"))
        await self.writer.drain()
        return await fut

    async def close(self) -> None:
        self.writer.close()
        self.task.cancel()
        if self.proc is not None:
            try:
                await asyncio.wait_for(self.proc.wait(), 2)
            except asyncio.TimeoutError:
                self.proc.kill()


class _HttpTransport:
    def __init__(self, url: str):
        self.url = url

    def _post(self, frame: dict) -> list[dict]:
        req = urllib.request.Request(
            self.url, data=dumps(frame).encode("utf-8"), method="POST", headers={"Content-Type": "application/json"}
        )
        with urllib.request.urlopen(req, timeout=60) as resp:
            return [loads(line) for line in resp.read().decode("utf-8").splitlines() if line.strip()]

    async def request(self, frame: dict, on_event: OnEvent | None) -> Reply:
        frames = await asyncio.to_thread(self._post, frame)
        if not frames:
            raise ConnectionError("empty response from HTTP bridge")
        events = [Reply(f) for f in frames[:-1]]
        for ev in events:
            if on_event:
                r = on_event(ev)
                if asyncio.iscoroutine(r):
                    await r
        return Reply(frames[-1], events)

    async def close(self) -> None:
        pass


class _LocalTransport:
    """Call a Service in-process (tests, embedding). Frames round-trip through JSON."""

    def __init__(self, service: Any):
        self.service = service

    async def request(self, frame: dict, on_event: OnEvent | None) -> Reply:
        events: list[Reply] = []

        def emit(f: dict) -> None:
            ev = Reply(loads(dumps(f)))
            events.append(ev)
            if on_event:
                on_event(ev)

        final = await self.service.handle(loads(dumps(frame)), emit)
        return Reply(loads(dumps(final)), events)

    async def close(self) -> None:
        pass


def local(service: Any) -> _LocalTransport:
    return _LocalTransport(service)


# ------------------------------------------------------------ client


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


async def connect(
    url: str,
    *,
    key: KeyPair | str | bytes | None = None,
    grants: Sequence[str | Grant] = (),
    name: str = "agent",
    budget: int | None = None,
    ssl_context: ssl.SSLContext | None = None,
) -> Client:
    """Connect to ``yea://host[:port]``, ``yeas://…``, ``http(s)://…``, or
    ``stdio:<command>`` (spawns the command and speaks NDJSON over its stdin/stdout)."""
    if url.startswith("stdio:"):
        argv = shlex.split(url[len("stdio:"):])
        if not argv:
            raise ValueError("stdio: needs a command, e.g. stdio:python serve.py --stdio")
        proc = await asyncio.create_subprocess_exec(
            *argv, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, limit=MAX_FRAME + 2
        )
        transport: Any = _StreamTransport(proc.stdout, proc.stdin, proc)
    elif url.startswith(("http://", "https://")):
        transport = _HttpTransport(url)
    else:
        u = urlsplit(url)
        if u.scheme not in ("yea", "yeas"):
            raise ValueError(f"unsupported URL {url}")
        tls = u.scheme == "yeas"
        port = u.port or (TLS_PORT if tls else DEFAULT_PORT)
        ctx = (ssl_context or ssl.create_default_context()) if tls else None
        reader, writer = await asyncio.open_connection(u.hostname or "127.0.0.1", port, ssl=ctx, limit=MAX_FRAME + 2)
        transport = _StreamTransport(reader, writer)
    return Client(transport, key, grants, name, budget)
