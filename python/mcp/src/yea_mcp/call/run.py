"""Running the chosen plan and recording its receipt, or saying why it wasn't recorded (step 11)."""

from __future__ import annotations

from typing import Any

import mcp_types as t
from pydantic_core import to_jsonable_python
from yea.approval import HashedPlan, new_receipt_id, settle_all
from yea.store import Reservation
from yea.text import printable
from yea.uses import check_uses

from ..render import error_result, receipt_result
from .model import Call, Result, _maybe, is_partial


async def _run_plan(call: Call, hp: HashedPlan, held: list[Reservation], how: str) -> Result:
    """Step 11: apply once, then settle and record the receipt. Once ``apply()`` has returned,
    nothing may say "nothing ran": a client told that would retry and run it again."""
    try:
        result = await _maybe(hp.plan.apply())
    except Exception as e:  # noqa: BLE001
        approved = how == "approved"
        said = f"✗ {'approved, but ' if approved else ''}{printable(hp.plan.summary)} failed"
        if is_partial(e):  # it changed something: the reservations stay held, which can only over-count
            used_up = " The approval is used up." if approved else ""
            return error_result([f"{said} part-way: {printable(str(e))}{used_up}"])
        await _release_each(call, held)
        return error_result([f"{said}: {printable(str(e))}; nothing changed."
                             f"{' The approval is used up: calling again asks again.' if approved else ''}"])
    if call.job.guarded and call.job.failed(result):  # a guarded tool's own error, or a request for input
        await _release_each(call, held)
        return result
    saved: dict[str, dict] = {}  # the receipt, once stored: a later failure can say undo is available
    try:
        return await _recorded(call, hp, held, result, how == "auto", saved)
    except Exception as e:  # noqa: BLE001
        return _happened(call, hp, f"then {e}", saved.get("receipt"), result if call.job.guarded else None)


async def _release_each(call: Call, held: list[Reservation]) -> None:
    """Release each reservation on its own. One that can't be released stays held, which only
    over-counts, and never hides why the plan failed."""
    for r in held:
        try:
            await call.y.store.release(r)
        except Exception:  # noqa: BLE001
            pass


def _receipt_for(call: Call, hp: HashedPlan, result: Any) -> dict:
    """The receipt a successful job leaves (SPEC-approval §8's job receipt)."""
    p = hp.plan
    receipt: dict[str, Any] = {"id": new_receipt_id(), "service": call.y.service_id, "proposal": hp.plan_hash,
                               "capability": hp.tool, "summary": p.summary, "at": call.now, "effects": p.effects}
    if (uses := check_uses(p.uses)) is not None:
        receipt["uses"] = uses
    receipt["undo"] = {"until": call.now + p.undo_window} if hp.undoable and p.undo_window is not None else None
    receipt |= {"tool": hp.tool, "input": call.input, "planHash": hp.plan_hash, "sub": call.sub}
    if result is not None:
        receipt["result"] = result
    return receipt


def json_safe(v: Any) -> tuple[Any, str | None]:
    """The result as plain JSON, or None and why it couldn't be (a circular or odd object)."""
    try:
        return to_jsonable_python(v, by_alias=True, exclude_none=True), None
    except (ValueError, TypeError) as e:
        first = str(e).split("\n")[0]
        return None, f"its result couldn't be serialized ({first}), so it isn't shown or kept"


async def _recorded(call: Call, hp: HashedPlan, held: list[Reservation], result: Any, auto: bool,
                    saved: dict[str, dict]) -> Result:
    """After ``apply()`` succeeded: settle, store the receipt (without a result that couldn't be
    serialized, so the job can still be undone), and return it."""
    safe, note = json_safe(result)
    receipt = _receipt_for(call, hp, safe)
    await settle_all(call.y.store, held)
    await call.y.store.put_receipt(receipt)
    saved["receipt"] = receipt
    if note:
        return _happened(call, hp, note, receipt, None)
    if call.job.guarded:
        return call.job.with_receipt(result, receipt)
    return receipt_result(receipt, auto)


def _happened(call: Call, hp: HashedPlan, what: str, receipt: dict | None, result: Any) -> Result:
    """The action happened, but something after it didn't: say so, and whether undo is available
    (mcp-ts's wording). A guarded tool's own result, when there is one, is kept with the line."""
    if receipt is None:
        undo = "its receipt wasn't saved, so it can't be undone"
    elif receipt.get("undo"):
        undo = f"undo is available with receipt {receipt['id']}"
    else:
        undo = f"receipt {receipt['id']}; it can't be undone"
    line = f"✓ {printable(hp.plan.summary)} happened, but {printable(what)}; {undo}."
    if call.job.guarded and result is not None:
        return call.job.with_note(result, line)
    # A guarded tool's outputSchema only describes the original's own results.
    return t.CallToolResult(content=[t.TextContent(type="text", text=line)],
                            structured_content={"receipt": receipt, "result": None},
                            is_error=call.job.own_results_are_errors())
