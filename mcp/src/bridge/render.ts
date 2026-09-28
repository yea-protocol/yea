/**
 * What the bridge shows the model (SPEC-bridge). Service replies are untrusted: they are always
 * re-rendered as Lens here (never the service's own `lens`), with every service-written string
 * outside `data` and `result` made one line, so a summary can't forge a line of ours.
 */
import type { CallToolResult } from '@modelcontextprotocol/server';
import { lens, type Proposal, printable, type Reply } from '@yea-protocol/sdk';

type Obj = Record<string, unknown>;

/** Lens renders these as lean values (strings quoted), so they keep their own text. */
const VALUES = new Set(['data', 'result']);

/** `v` with every string made one line, except under `data` and `result`. */
function oneLine(v: unknown): unknown {
  if (typeof v === 'string') {
    return printable(v);
  }

  if (Array.isArray(v)) {
    return v.map(oneLine);
  }

  if (typeof v !== 'object' || v === null) {
    return v;
  }

  return Object.fromEntries(
    Object.entries(v as Obj).map(([k, x]) => [
      printable(k),
      VALUES.has(k) ? x : oneLine(x),
    ]),
  );
}

/** Lens renders line separators inside quoted values literally; nothing but `\n` breaks a line. */
const noSeparators = (s: string) =>
  s.replace(/[\u2028\u2029]/g, (c) => printable(c));

/** A service reply as Lens, re-rendered from its fields after `oneLine`. */
export function safeLens(reply: Reply): string {
  const { lens: _ignored, ...rest } = reply;

  return noSeparators(lens(oneLine(rest) as Reply));
}

/** Proposals as the PROPOSALS Lens shows them, without its frame. */
export const proposalsLens = (proposals: Proposal[]) =>
  safeLens({ yea: 1, id: '-', re: '-', kind: 'PROPOSALS', proposals });

export const textOf = (lines: string[]) => [
  { type: 'text' as const, text: lines.join('\n') },
];

/** A refusal or failure: `isError`, so the model sees the reason and the fix. */
export function errorResult(lines: string[], structured?: Obj): CallToolResult {
  return {
    content: textOf(lines),
    isError: true,
    ...(structured ? { structuredContent: structured } : {}),
  };
}

/** A reply as a tool result: its Lens, `isError` for an ERROR, and `structured` as data. */
export function replyResult(
  reply: Reply,
  structured?: Obj,
  extra: string[] = [],
): CallToolResult {
  return {
    content: textOf([safeLens(reply), ...extra]),
    ...(reply.kind === 'ERROR' ? { isError: true } : {}),
    ...(structured ? { structuredContent: structured } : {}),
  };
}

/** A proposal as data for `structuredContent`: never its `data`, which may be large. */
export const proposalView = ({ data: _d, ...p }: Proposal) => oneLine(p) as Obj;
