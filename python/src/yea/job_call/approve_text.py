"""What the model passes on when the person has to approve outside the chat (SPEC-approval §6, "How
to approve"): run ``yea approve`` in a terminal outside this chat, by short id when every code has
one, else by the whole code; and, when the person pastes a consent back, carry it on the call. The
MCP SDKs render it under the plans; conformance/job-calls.json pins it. As
ts/src/job-call/approve-text.ts."""

from __future__ import annotations

from collections.abc import Sequence

_PASTE_BACK = ("If the user pastes back a consent that `yea approve` printed (pg1.…), call this tool again "
               "with the same arguments and `yea_consent` set to it.")


def how_to_approve(plan_hashes: Sequence[str], codes: Sequence[dict]) -> list[str]:
    """The lines, with each code (``planHash``, ``code`` and maybe ``id``) numbered by its plan's
    place in ``plan_hashes``, as the plans are shown."""
    hashes = list(plan_hashes)

    def n(c: dict) -> int:
        return hashes.index(c["planHash"]) + 1 if c["planHash"] in hashes else 0

    code_lines = [f"  code for [{n(c)}]: {c['code']}" for c in codes]
    if not codes or not all(c.get("id") for c in codes):
        return ["Ask the user to run `yea approve <code>` in a terminal outside this chat, then call this tool "
                "again with the same arguments.", *code_lines, _PASTE_BACK]
    return ["Ask the user to run `yea approve <id>` in a terminal outside this chat, then call this tool again "
            "with the same arguments.",
            *(f"  [{n(c)}] yea approve {c['id']}" for c in codes),
            "If `yea approve` can't find the id (run as another OS user, or on another device), give it the "
            "whole code instead:",
            *code_lines, _PASTE_BACK]
