"""The guard (SPEC-mcp-py, ``approvals.guard``): server middleware that turns tools already
registered on one ``MCPServer`` into jobs, without touching their code.

SDK seam: ``server.middleware`` is public but provisional in ``mcp`` 2.x. The SDK puts its own
middleware (the request-state boundary) first, so this one sees plaintext state; it runs before
params are validated; ``call_next`` returns the wire mapping for ``tools/call`` and
``tools/list``; and ``replace(ctx, params=...)`` changes what the handler gets."""

from __future__ import annotations

import copy
from collections.abc import Callable
from dataclasses import dataclass, field, replace
from typing import Any

from mcp_types.methods import is_input_required
from yea import Plan

from .call import CONSENT_DESCRIPTION, JobDef, Req, Reserved, Yea, described_plans, run_job, shadowed
from .result import error_result, job_annotations, job_meta


@dataclass
class Guarded:
    describe: Callable[[dict], Any]
    revert: Callable[..., Any] | None
    confirm_with: Callable[..., str] | None
    risk: str | None = None  # the default plan risk, and the risk its listing shows
    require_interaction: bool | None = None  # None: yea()'s

    def prompts(self, y: Yea) -> bool:
        """Whether its listing carries Claude Code's prompt key: its own setting, else ``yea()``'s."""
        return y.require_interaction if self.require_interaction is None else self.require_interaction


@dataclass
class _Info:
    shadowed: str | None  # a reserved argument the tool has its own of, which the guard would shadow
    has_output: bool
    is_job: bool  # registered with job(): already guarded


@dataclass
class GuardMiddleware:
    """One per server: the guarded tools of that server, and what its listing says about them."""

    y: Yea
    server: Any
    tools: dict[str, Guarded] = field(default_factory=dict)

    async def __call__(self, ctx: Any, call_next: Callable[[Any], Any]) -> Any:
        params = ctx.params if isinstance(ctx.params, dict) else {}
        if ctx.method == "tools/list":
            return self._advertise(await call_next(ctx))
        if ctx.method == "tools/call" and params.get("name") in self.tools:
            return await self._call(ctx, params, call_next)
        return await call_next(ctx)

    def add(self, name: str, g: Guarded) -> None:
        if name in self.tools:
            raise ValueError(f"guard(): {name} is already guarded on this server")
        self.tools[name] = g

    async def _learn(self, name: str) -> _Info | None:
        """What the listing says about the guarded tool ``name`` now: read on every guarded call (it's
        in memory), so a tool re-registered since is judged by what's there."""
        tool = next((t for t in await self.server.list_tools() if t.name == name), None)
        if tool is None:
            return None
        return _Info(shadowed(tool.input_schema), tool.output_schema is not None, "dev.yea/job" in (tool.meta or {}))

    def _advertise(self, result: Any) -> Any:
        """Add ``preview``, ``yea_consent`` and the job annotations to guarded tools in a copy of the
        listing."""
        if not isinstance(result, dict):
            return result
        out = copy.deepcopy(result)
        for tool in out.get("tools") or []:
            g = self.tools.get(tool.get("name"))
            if g is None:
                continue
            props = tool.setdefault("inputSchema", {"type": "object"}).setdefault("properties", {})
            props.setdefault("preview", {"type": "boolean", "default": False})
            props.setdefault("yea_consent", {"anyOf": [{"type": "string"}, {"type": "null"}], "default": None,
                                             "description": CONSENT_DESCRIPTION})
            tool["annotations"] = {**job_annotations(), **(tool.get("annotations") or {})}
            tool["_meta"] = {**(tool.get("_meta") or {}), **job_meta(g.risk, g.revert is not None, g.prompts(self.y))}
        return out

    async def _call(self, ctx: Any, params: dict, call_next: Callable[[Any], Any]) -> Any:
        name = params["name"]
        g = self.tools[name]
        info = await self._learn(name)
        args = params.get("arguments")
        args = {} if args is None else args
        if info is None:
            return error_result([f"✗ guard(): {name} isn't registered on this server; nothing was run"])
        if info.is_job:  # guarding it would run two approval routines, one inside the other
            return error_result([f"✗ guard(): {name} is already a job tool; nothing was run"])
        if not isinstance(args, dict):
            return error_result([f"✗ {name}'s arguments must be an object; nothing was run"])
        if info.shadowed:
            return error_result([f"✗ guard(): {name} has its own {info.shadowed} argument, which the guard would "
                                 "shadow; nothing was run"])
        args = dict(args)
        preview, consent = args.pop("preview", False), args.pop("yea_consent", None)
        why = _reserved_issue(preview, consent)
        if why:
            return error_result([f"✗ {why}; nothing was run"])
        stripped = replace(ctx, params={**params, "arguments": args})

        async def plan() -> list[Plan]:
            return await described_plans(g.describe, dict(args), lambda: call_next(stripped))

        job = JobDef(name, g.risk, g.revert, g.confirm_with, guarded=True, own_results_are_errors=lambda: info.has_output,
                     failed=wire_failed, with_receipt=wire_with_receipt, with_note=wire_with_note)
        req = Req(ctx, ctx.session, ctx.request_id, ctx.protocol_version, params.get("requestState"),
                  params.get("inputResponses"))
        return await run_job(self.y, job, args, Reserved(preview, consent), req, plan)


def _reserved_issue(preview: Any, consent: Any) -> str | None:
    """Why the reserved arguments can't be used, as the job schema would say: the guard runs before
    the tool's own validation. ``preview`` is a JSON boolean, and ``yea_consent`` a string or null."""
    if not isinstance(preview, bool):
        return "preview must be true or false"
    if consent is not None and not isinstance(consent, str):
        return "yea_consent must be a string: the consent yea approve printed"
    return None


def wire_failed(result: Any) -> bool:
    """``MCPServer``'s ``call_next`` hands back the wire mapping: read it structurally, assume no class."""
    if is_input_required(result):
        return True
    return result.get("isError") is True if isinstance(result, dict) else True


def wire_with_receipt(result: Any, receipt: dict) -> Any:
    return {**result, "_meta": {**(result.get("_meta") or {}), "dev.yea/receipt": receipt}}


def wire_with_note(result: Any, note: str) -> Any:
    return {**result, "content": [*(result.get("content") or []), {"type": "text", "text": note}]}
