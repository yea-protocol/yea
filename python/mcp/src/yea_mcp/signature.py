"""The job tool's synthesized signature (SPEC-mcp-py, "How `preview` gets in" and "What `input`
is").

SDK seam: ``func_metadata`` builds the input schema and argument model from ``__signature__``,
and ``find_context_parameter`` reads ``typing.get_type_hints``, so the wrapper carries both. The
same construction works for FastMCP's ``Tool.from_function``."""

from __future__ import annotations

import inspect
import typing
from collections.abc import Awaitable, Callable
from typing import Any

import mcp_types as t
from pydantic import StrictBool, TypeAdapter

Runner = Callable[[dict, Callable[[], Awaitable[Any]], bool, Any], Awaitable[Any]]
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
        if p.name == "preview":
            raise TypeError(f"job {name!r}: the plan function has its own preview parameter, which job() adds")


def job_wrapper(plan_fn: Callable[..., Any], name: str, context_type: type, run: Runner) -> Callable[..., Any]:
    """A tool function with the plan function's parameters plus ``preview: bool = False`` and a
    context parameter (the plan function's own, if it declares one). Calling it builds the JSON
    input and hands the routine a way to call the plan function."""
    sig = inspect.signature(plan_fn)
    _check(sig, name)
    hints = typing.get_type_hints(plan_fn)
    own_ctx = _context_param(hints, context_type)
    ctx_name = own_ctx or ("ctx" if "ctx" not in sig.parameters else "_yea_ctx")
    # StrictBool: a JSON boolean only; lax pydantic would turn "true" into True.
    # Resolved annotations: the SDK evaluates string annotations in this module, not the author's.
    own = [p.replace(annotation=hints.get(p.name, p.annotation)) for p in sig.parameters.values()]
    params = [*own, _P("preview", _P.KEYWORD_ONLY, default=False, annotation=StrictBool)]
    if own_ctx is None:
        params.append(_P(ctx_name, _P.KEYWORD_ONLY, annotation=context_type))
    adapters = {p.name: TypeAdapter(hints.get(p.name, Any)) for p in sig.parameters.values() if p.name != own_ctx}

    async def tool(**kw: Any) -> Any:
        ctx = kw[ctx_name] if own_ctx else kw.pop(ctx_name)
        preview = kw.pop("preview", False)
        input = {k: adapters[k].dump_python(v, mode="json", by_alias=True) for k, v in kw.items() if k != own_ctx}

        async def plan() -> Any:
            out = plan_fn(**kw)
            return await out if inspect.isawaitable(out) else out

        return await run(input, plan, preview, ctx)

    ret = t.CallToolResult | t.InputRequiredResult
    tool.__signature__ = sig.replace(parameters=params, return_annotation=ret)  # type: ignore[attr-defined]
    tool.__annotations__ = {p.name: p.annotation for p in params if p.annotation is not _P.empty} | {"return": ret}
    tool.__name__ = name
    tool.__doc__ = plan_fn.__doc__
    return tool
