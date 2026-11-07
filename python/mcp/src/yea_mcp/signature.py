"""The job tool's synthesized signature (SPEC-mcp-py, "How `preview` and `yea_consent` get in" and
"What `input` is").

SDK seam: ``func_metadata`` builds the input schema and argument model from ``__signature__``,
and ``find_context_parameter`` reads ``typing.get_type_hints``, so the wrapper carries both. The
same construction works for FastMCP's ``Tool.from_function``."""

from __future__ import annotations

import inspect
import typing
from collections.abc import Awaitable, Callable
from typing import Annotated, Any

import mcp_types as t
from pydantic import Field, StrictBool, StrictStr, TypeAdapter

from .call import CONSENT_DESCRIPTION, RESERVED_ARGS, Reserved, _maybe

Runner = Callable[[dict, Callable[[], Awaitable[Any]], Reserved, Any], Awaitable[Any]]
# A JSON string or null only; lax pydantic would turn a number into a string.
_Consent = Annotated[StrictStr | None, Field(description=CONSENT_DESCRIPTION)]
_P = inspect.Parameter


def _context_param(hints: dict[str, Any], context_type: type) -> str | None:
    for name, ann in hints.items():
        if name != "return" and inspect.isclass(ann) and issubclass(ann, context_type):
            return name
    return None


def _check(sig: inspect.Signature, name: str) -> None:
    for p in sig.parameters.values():
        if p.kind in (_P.VAR_POSITIONAL, _P.VAR_KEYWORD):
            raise TypeError(f"job {name!r}: the plan function can't take *args or **kwargs")
        if p.name in RESERVED_ARGS:
            raise TypeError(f"job {name!r}: the plan function has its own {p.name} parameter, which job() adds")


def job_wrapper(plan_fn: Callable[..., Any], name: str, context_type: type, run: Runner,
                injected: frozenset[str] = frozenset()) -> Callable[..., Any]:
    """A tool function with the plan function's parameters plus ``preview: bool = False``,
    ``yea_consent: str | None = None`` and a context parameter (the plan function's own, if it
    declares one). Calling it builds the JSON input and hands the routine a way to call the plan
    function. ``injected`` names parameters the SDK fills in itself (FastMCP ``Depends``): passed
    through, but not part of the input."""
    sig = inspect.signature(plan_fn)
    _check(sig, name)
    hints = typing.get_type_hints(plan_fn)
    own_ctx = _context_param(hints, context_type)
    ctx_name = own_ctx or ("ctx" if "ctx" not in sig.parameters else "_yea_ctx")
    # StrictBool: a JSON boolean only; lax pydantic would turn "true" into True.
    # Resolved annotations: the SDK evaluates string annotations in this module, not the author's.
    own = [p.replace(annotation=hints.get(p.name, p.annotation)) for p in sig.parameters.values()]
    params = [*own, _P("preview", _P.KEYWORD_ONLY, default=False, annotation=StrictBool),
              _P("yea_consent", _P.KEYWORD_ONLY, default=None, annotation=_Consent)]
    if own_ctx is None:
        params.append(_P(ctx_name, _P.KEYWORD_ONLY, annotation=context_type))
    skip = {own_ctx, *injected}
    adapters = {p.name: TypeAdapter(hints.get(p.name, Any)) for p in sig.parameters.values() if p.name not in skip}

    async def tool(**kw: Any) -> Any:
        ctx = kw[ctx_name] if own_ctx else kw.pop(ctx_name)
        reserved = Reserved(kw.pop("preview", False), kw.pop("yea_consent", None))
        input = {k: adapters[k].dump_python(v, mode="json", by_alias=True) for k, v in kw.items() if k not in skip}

        async def plan() -> Any:
            return await _maybe(plan_fn(**kw))

        return await run(input, plan, reserved, ctx)

    ret = t.CallToolResult | t.InputRequiredResult
    tool.__signature__ = sig.replace(parameters=params, return_annotation=ret)  # type: ignore[attr-defined]
    tool.__annotations__ = {p.name: p.annotation for p in params if p.annotation is not _P.empty} | {"return": ret}
    tool.__name__ = name
    tool.__doc__ = plan_fn.__doc__
    return tool
