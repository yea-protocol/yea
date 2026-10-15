"""The job call session (GLOSSARY.md "Job call"; docs/framework/SPEC-approval.md, "How a job call
runs"): one call of a job tool, from the plans its handler returns to an outcome. It owns the order
that makes the approval core's decisions safe:

- a denied tool is refused before its handler runs, so it shows nothing, not even a preview;
- a stored consent is consumed before its plan runs, and tried before the policy;
- totals are reserved after the policy decides, all or nothing;
- a returned state is checked and its nonce consumed before the answer is judged.

It's a step function: each round of a call is one ``job_call``, given the store and, on a retry,
the state the last round handed out and the person's answer. The adapter (an MCP SDK) only reads
the request, carries the state round the client, and turns outcomes into results.

The entry of the ``yea.job_call`` package; its modules are its parts."""

from __future__ import annotations

from ..approval import input_hash
from ..approval.decision import denied_reason
from ..store import ApprovalStore
from .answer import answer_round
from .first import first_round
from .outcome import JobCall, JobTool, Outcome, Retry, Round
from .plans import hash_plans, phrase_of, plans_of

__all__ = ["JobCall", "JobTool", "Outcome", "Retry", "hash_plans", "job_call"]


async def job_call(call: JobCall, store: ApprovalStore, retry: Retry | None = None) -> Outcome:
    """One round of a job call. A first round tries a stored consent, then the policy, then asks; a
    retry judges the person's answer. It raises on a developer's error (a non-integer input, a
    handler that returns neither plans nor a clarification, an untypeable phrase) and on a store
    failure, before anything has run: the adapter refuses the call with the message."""
    input_hash(call.input)  # canonical JSON, so integer-only numbers
    if call.tool.name in call.policy.deny:
        return Outcome("refuse", denied_reason(call.tool.name))
    planned = await plans_of(call)
    if isinstance(planned, Outcome):
        return planned
    if call.preview:
        return Outcome("preview", plans=planned)
    r = Round(call, planned, store, phrase_of(call))
    return await answer_round(r, retry) if retry is not None else await first_round(r)
