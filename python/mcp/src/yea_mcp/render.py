"""What a job call returns (SPEC-mcp-py, "Results and annotations"): Lens text for the model, and
the same as data in ``structured_content``. The texts match mcp-ts."""

from __future__ import annotations

from typing import Any

import mcp_types as t
from yea import lean
from yea.approval import HashedPlan, plan_lines, shown_plan
from yea.lens import untrusted_lens
from yea.service import Clarification
from yea.text import printable

from .result import error_result, text_content


def plan_view(hp: HashedPlan) -> dict:
    """A plan as data: what the model and the person see, never ``apply`` or ``data``."""
    shown = shown_plan(hp)
    window = shown.pop("undoWindow", None)
    view: dict[str, Any] = {"planHash": hp.plan_hash, **shown}
    view["undo"] = None if window is None else {"window": window}
    return view


def plans_text(plans: list[HashedPlan]) -> list[str]:
    head = f"{len(plans)} plan{'' if len(plans) == 1 else 's'}:"
    return [head, *(line for i, hp in enumerate(plans, 1) for line in plan_lines(shown_plan(hp), i))]


def preview_result(plans: list[HashedPlan], as_error: bool) -> t.CallToolResult:
    """``preview: true``: the plans, and nothing run or stored. ``as_error`` is for a guarded tool
    with an output schema, which only describes its real results (decision 6)."""
    return t.CallToolResult(
        content=text_content(["preview: nothing was run", *plans_text(plans),
                              "Call again without preview to run the first plan, or to ask the user."]),
        structured_content={"plans": [plan_view(hp) for hp in plans]},
        is_error=as_error,
    )


def _how_to_approve(plans: list[HashedPlan], codes: list[dict]) -> list[str]:
    """How to approve outside the chat (SPEC-approval §6): by short id when there are ids, else by code."""
    code_lines = [f"  code for [{_number(plans, c)}]: {c['code']}" for c in codes]
    if not codes or not all(c.get("id") for c in codes):
        return ["Ask the user to run `yea approve <code>` in a terminal outside this chat, then call this tool "
                "again with the same arguments.", *code_lines]
    return ["Ask the user to run `yea approve <id>` in a terminal outside this chat, then call this tool again "
            "with the same arguments.",
            *(f"  [{_number(plans, c)}] yea approve {c['id']}" for c in codes),
            "If `yea approve` can't find the id (run as another OS user, or on another device), give it the "
            "whole code instead:",
            *code_lines]


def consent_result(why: str, plans: list[HashedPlan], codes: list[dict], unavailable: str | None) -> t.CallToolResult:
    """No approval could be asked for here: the plans, and a consent code (and its id) for each."""
    tail = [f"No consent can be accepted: {unavailable}."] if unavailable else _how_to_approve(plans, codes)
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
