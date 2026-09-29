"""yea-mcp: YEA's approval contract for MCP servers (docs/framework/SPEC-mcp-py.md).

A job tool returns plans instead of acting. Within the person's signed policy the first plan runs;
outside it the person approves in their client by typing a phrase; when the client can't ask, the
call returns consent codes for ``yea approve``. Anything reversible can be undone."""

from __future__ import annotations

import os
import secrets
import sys
import weakref
from collections.abc import Callable
from typing import Any

import mcp_types as t
from mcp.server.auth.middleware.auth_context import get_access_token
from mcp.server.mcpserver import Context
from mcp.server.request_state import RequestStateSecurity
from yea.approval import STATE_TTL, HashedPlan
from yea.store import (
    ApprovalStore,
    FileStore,
    MemoryStore,
    default_store_dir,
)

from .call import (
    JobDef,
    PartialApplyError,
    Req,
    Yea,
    is_memory_store,
    run_job,
)
from .guard import Guarded, GuardMiddleware
from .policy import pinned_principal
from .result import job_annotations, job_meta
from .server_key import check_name, default_key_path, load_server_key
from .signature import job_wrapper
from .undo import add_undo_tool, has_tool
from .util import fastmcp_of, warn_once

__all__ = ["Approvals", "PartialApplyError", "token_subject", "yea"]



def token_subject(ctx: Any = None) -> str:
    """The verified OAuth token's subject, or ``""`` when there is none. A client id alone names an
    app, not a person, so it never counts (SPEC-mcp-py, "HTTP serves one person")."""
    token = get_access_token()
    subject = getattr(token, "subject", None) if token is not None else None
    return subject if isinstance(subject, str) else ""


def _default_store(transport: str) -> ApprovalStore:
    if transport == "http":
        return MemoryStore()
    env = os.environ.get("YEA_STORE")
    return FileStore(env if env else default_store_dir())


def _state_key(key: bytes | str | None) -> bytes:
    raw = key.encode() if isinstance(key, str) else key
    if raw is None:
        return secrets.token_bytes(32)
    if len(raw) < 32:
        raise ValueError("yea(): state_key must be at least 32 bytes")
    return raw


def _check_options(transport: str, sub: Any, store: ApprovalStore, single_process: bool, state_key: Any) -> None:
    """The start-up refusals: nothing is served when one applies."""
    if transport not in ("stdio", "http"):
        raise ValueError("yea(): transport must be 'stdio' or 'http'")
    if transport == "http" and not callable(sub):
        raise ValueError("yea(): HTTP needs sub(ctx), the authenticated person calling (see token_subject)")
    if state_key is not None and is_memory_store(store):
        raise ValueError("yea(): a shared state_key needs a shared store; with a MemoryStore each process "
                         "would accept the same approval once")
    if transport == "http" and is_memory_store(store) and not single_process:
        raise ValueError("yea(): HTTP on a MemoryStore needs single_process=True, or pass a store every process shares")


def yea(*, name: str, transport: str, store: ApprovalStore | None = None, single_process: bool = False,
        server_key: str | os.PathLike[str] | None = None, principal: str | None = None, policy: str | None = None,
        tighten: dict | None = None, state_key: bytes | str | None = None,
        sub: Callable[[Any], str] | None = None) -> Approvals:
    """The approval context, once per process (SPEC-mcp-py ``yea()``)."""
    check_name(name)
    chosen = store if store is not None else _default_store(transport)
    _check_options(transport, sub, chosen, single_process, state_key)
    key = load_server_key(server_key if server_key is not None else default_key_path(name))
    y = Yea(name=name, transport=transport, store=chosen,
            shared_memory=is_memory_store(chosen) and not single_process,
            principal=pinned_principal(principal), policy=policy, tighten=tighten, service_id=key.public,
            sub=sub if sub is not None else (lambda rctx: ""))
    _announce(y)
    return Approvals(y, _state_key(state_key))


def _announce(y: Yea) -> None:
    """The start-up lines on stderr, as mcp-ts prints them: the service id to issue a policy to,
    and why nothing will auto-run when no principal key is pinned."""
    if y.principal.key is None:
        warn_once(f"no pinned principal key ({y.principal.why}): nothing auto-runs and no consent is accepted")
    print(f"yea: service id {y.service_id} (name {y.name})", file=sys.stderr)


class Approvals:
    """What ``yea()`` returns: register jobs and guards on a server."""

    def __init__(self, y: Yea, state_key: bytes):
        self._y = y
        self._state_key = state_key
        self._guards: weakref.WeakKeyDictionary[Any, GuardMiddleware] = weakref.WeakKeyDictionary()
        self._reverts: weakref.WeakKeyDictionary[Any, dict[str, Callable[..., Any]]] = weakref.WeakKeyDictionary()
        self._jobs: weakref.WeakKeyDictionary[Any, set[str]] = weakref.WeakKeyDictionary()  # job() names per server

    def service_id(self) -> str:
        """This server's service id (its public key): pass it to ``yea grant --to``."""
        return self._y.service_id

    def request_state_security(self) -> RequestStateSecurity:
        """For ``MCPServer(request_state_security=...)``: the SDK seals our state with this key."""
        return RequestStateSecurity(keys=[self._state_key], ttl=STATE_TTL, audience=self._y.name)

    def job(self, server: Any, *, name: str | None = None, title: str | None = None, description: str | None = None,
            annotations: t.ToolAnnotations | dict | None = None, risk: str | None = None,
            revert: Callable[..., Any] | None = None,
            confirm_with: Callable[[HashedPlan, dict], str] | None = None) -> Callable[[Callable[..., Any]], Any]:
        """Decorator: register the plan function as a job tool on ``server``."""

        def register(plan_fn: Callable[..., Any]) -> Callable[..., Any]:
            tool_name = name or plan_fn.__name__
            if revert is not None:
                if tool_name == "undo":
                    raise ValueError("job(): a job with revert can't be named undo; that's YEA's undo tool")
                self._undo_free(server)
            job = JobDef(tool_name, risk, revert, confirm_with)

            async def run(input: dict, plan: Any, preview: bool, ctx: Context) -> Any:
                req = Req(ctx.request_context, ctx.session, ctx.request_context.request_id, ctx.protocol_version,
                          ctx.request_state, ctx.input_responses)
                return await run_job(self._y, job, input, preview, req, plan)

            given = job_annotations(_as_dict(annotations))
            meta = job_meta(risk, revert is not None)
            if (fm := fastmcp_of(server)) is not None:
                fm.add_job(self._y, server, plan_fn, job, title, description or plan_fn.__doc__, given, meta)
            else:
                fn = job_wrapper(plan_fn, tool_name, Context, run)
                server.add_tool(fn, name=tool_name, title=title, description=description or plan_fn.__doc__,
                                annotations=t.ToolAnnotations(**given), meta=meta)
            self._jobs.setdefault(server, set()).add(tool_name)
            if revert is not None:
                self._undo_for(server)[tool_name] = revert
            return plan_fn

        return register

    def guard(self, server: Any, name: str, *, describe: Callable[[dict], Any],
              revert: Callable[..., Any] | None = None,
              confirm_with: Callable[[HashedPlan, dict], str] | None = None, risk: str | None = None) -> None:
        """Turn the tool ``name`` already registered on ``server`` into a job, without touching it."""
        if name in self._jobs.get(server, ()):  # the listing's meta refuses one registered elsewhere, per call
            raise ValueError(f"guard(): {name} is already a job tool")
        if revert is not None:
            self._undo_free(server)
        mw = self._guards.get(server)
        if mw is None:
            fm = fastmcp_of(server)
            mw = fm.FastMCPGuard(self._y, server) if fm is not None else GuardMiddleware(self._y, server)
            self._guards[server] = mw
            if fm is not None:
                server.middleware.insert(0, mw)  # first, so no other middleware can run the tool before it's wrapped
            else:
                server.middleware.append(mw)
        mw.add(name, Guarded(describe, revert, confirm_with, risk))
        if revert is not None:
            self._undo_for(server)[name] = revert

    def _undo_free(self, server: Any) -> None:
        """Refuse, before registering anything, a server whose ``undo`` tool isn't ours (as mcp-ts)."""
        if server not in self._reverts and has_tool(server, "undo"):
            raise ValueError("this server already has a tool named undo (its own, or another yea() instance's); a job "
                             "with revert needs YEA's undo tool")

    def _undo_for(self, server: Any) -> dict[str, Callable[..., Any]]:
        """The ``undo`` tool's revert map for ``server``, registering the tool the first time."""
        reverts = self._reverts.get(server)
        if reverts is None:
            reverts = self._reverts[server] = add_undo_tool(self._y, server)
        return reverts


def _as_dict(a: t.ToolAnnotations | dict | None) -> dict:
    if a is None:
        return {}
    if isinstance(a, dict):
        return a
    return a.model_dump(by_alias=True, exclude_none=True)
