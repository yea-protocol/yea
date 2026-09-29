"""What a job call returns (SPEC-mcp-py, "Results and annotations"): Lens text for the model, and
the same as data in ``structured_content``. The texts match mcp-ts."""

from __future__ import annotations

from typing import Any

import mcp_types as t
from yea import lean
from yea.approval import HashedPlan
from yea.lens import fmt_duration, safe_effect_line, untrusted_lens
from yea.service import Clarification
from yea.text import printable
from yea.uses import check_uses, fmt_uses

from .result import error_result, text_content


def plan_view(hp: HashedPlan) -> dict:
    """A plan as data: what the model and the person see, never ``apply`` or ``data``."""
    p = hp.plan
    view: dict[str, Any] = {"planHash": hp.plan_hash, "summary": p.summary, "effects": p.effects}
    if (uses := check_uses(p.uses)) is not None:
        view["uses"] = uses
    view["risk"] = hp.risk
    view["undo"] = {"window": p.undo_window} if hp.undoable and p.undo_window is not None else None
    return view


def _plan_lines(n: int, hp: HashedPlan) -> list[str]:
    v = plan_view(hp)
    attrs = [*([f"uses: {fmt_uses(v['uses'])}"] if "uses" in v else []), f"risk: {v['risk']}",
             f"undo: {fmt_duration(v['undo']['window']) if v['undo'] else 'never'}"]
    # Service text is untrusted: escaped, so a summary can't forge lines or hide characters.
    return [f"[{n}] {printable(v['summary'])}", *(f"  {safe_effect_line(e)}" for e in v["effects"]),
            "  " + " · ".join(attrs)]


def plans_text(plans: list[HashedPlan]) -> list[str]:
    head = f"{len(plans)} plan{'' if len(plans) == 1 else 's'}:"
    return [head, *(line for i, hp in enumerate(plans, 1) for line in _plan_lines(i, hp))]


def preview_result(plans: list[HashedPlan], as_error: bool) -> t.CallToolResult:
    """``preview: true``: the plans, and nothing run or stored. ``as_error`` is for a guarded tool
    with an output schema, which only describes its real results (decision 6)."""
    return t.CallToolResult(
        content=text_content(["preview: nothing was run", *plans_text(plans),
                              "Call again without preview to run the first plan, or to ask the user."]),
        structured_content={"plans": [plan_view(hp) for hp in plans]},
        is_error=as_error,
    )


def consent_result(why: str, plans: list[HashedPlan], codes: list[dict], unavailable: str | None) -> t.CallToolResult:
    """No approval could be asked for here: the plans, and a consent code for each."""
    if unavailable:
        tail = [f"No consent can be accepted: {unavailable}."]
    else:
        tail = ["Ask the user to run `yea approve <code>` in their terminal, then call again.",
                *(f"  code for [{_number(plans, c)}]: {c['code']}" for c in codes)]
    return error_result([f"✗ approval needed: {printable(why)}; nothing was run", *plans_text(plans), *tail],
                        {"plans": [plan_view(hp) for hp in plans], "codes": codes})


def _number(plans: list[HashedPlan], c: dict) -> int:
    return next(i for i, hp in enumerate(plans, 1) if hp.plan_hash == c["planHash"])


def receipt_result(receipt: dict, auto: bool) -> t.CallToolResult:
    """A job's receipt as Lens (the protocol's RECEIPT), with the job's result."""
    line = untrusted_lens({"yea": 1, "id": receipt["id"], "re": receipt["proposal"], "kind": "RECEIPT",
                           "receipt": receipt, "auto": auto})
    return t.CallToolResult(content=text_content([line]),
                            structured_content={"receipt": receipt, "result": receipt.get("result")})


def clarify_result(c: Clarification) -> t.CallToolResult:
    """A plan's question back to the model, with what to call again with for each answer."""
    lines = [f"? {printable(c.question)}"]
    lines += [printable(f"  {i}. {printable(str(o.get('label', '')))} → {', '.join(lean(o.get('params', {})).split(chr(10)))}")
              for i, o in enumerate(c.options, 1)]
    return t.CallToolResult(content=text_content(lines),
                            structured_content={"clarify": {"question": c.question, "options": c.options}})
