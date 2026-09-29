"""What every job tool's result and listing share: text content, the refusal shape, the words for
nothing having run, and a job's annotations and meta (SPEC-mcp-py)."""

from __future__ import annotations

import mcp_types as t

NOTHING_RAN = "nothing was run"


def text_content(lines: list[str]) -> list[t.TextContent]:
    return [t.TextContent(type="text", text="\n".join(lines))]


def error_result(lines: list[str], structured: dict | None = None) -> t.CallToolResult:
    """A refusal or failure: ``is_error``, so the model sees the reason and the fix."""
    return t.CallToolResult(content=text_content(lines), is_error=True, structured_content=structured)


def job_annotations(given: dict | None = None) -> dict:
    """Job defaults, under whatever the author set: a job changes things."""
    return {"readOnlyHint": False, "destructiveHint": True, "idempotentHint": False, **(given or {})}


def job_meta(risk: str | None, undoable: bool) -> dict:
    return {"dev.yea/job": {"risk": risk or "medium", "undoable": undoable}}
