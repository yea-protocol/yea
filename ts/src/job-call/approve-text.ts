/**
 * What the model passes on when the person has to approve outside the chat (SPEC-approval §6,
 * "How to approve"): run `yea approve` in a terminal outside this chat, by short id when every
 * code has one, else by the whole code; and, when the person pastes a consent back, carry it on
 * the call. The MCP SDKs render it under the plans; conformance/job-calls.json pins it.
 */

/** A consent code as a result names it: with its short id, once its pending file is written. */
export interface ApprovalCode {
  planHash: string;
  code: string;
  id?: string;
}

const PASTE_BACK =
  'If the user pastes back a consent that `yea approve` printed (pg1.…), call this tool again with the same arguments and `yea_consent` set to it.';

/** The lines, with each code numbered by its plan's place in `planHashes`, as the plans are shown. */
export function howToApprove(
  planHashes: readonly string[],
  codes: readonly ApprovalCode[],
): string[] {
  const n = (c: ApprovalCode) => planHashes.indexOf(c.planHash) + 1;
  const codeLines = codes.map((c) => `  code for [${n(c)}]: ${c.code}`);

  if (!codes.length || !codes.every((c) => c.id)) {
    return [
      'Ask the user to run `yea approve <code>` in a terminal outside this chat, then call this tool again with the same arguments.',
      ...codeLines,
      PASTE_BACK,
    ];
  }

  return [
    'Ask the user to run `yea approve <id>` in a terminal outside this chat, then call this tool again with the same arguments.',
    ...codes.map((c) => `  [${n(c)}] yea approve ${c.id}`),
    "If `yea approve` can't find the id (run as another OS user, or on another device), give it the whole code instead:",
    ...codeLines,
    PASTE_BACK,
  ];
}
