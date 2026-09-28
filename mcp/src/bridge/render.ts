/**
 * What the bridge shows the model (SPEC-bridge). Service replies are untrusted: they are always
 * re-rendered as Lens here (never the service's own `lens`), with every service-written string
 * outside `data` and `result` made one line, so a summary can't forge a line of ours.
 */
import type { CallToolResult } from '@modelcontextprotocol/server';
import {
  oneLine,
  type Proposal,
  printable,
  type Reply,
  untrustedLens,
} from '@yea-protocol/sdk';
import { textResult } from '../result.js';
import type { Obj } from '../util.js';

/** Service-written text shown outside a result (summaries, descriptions) is cut to this. */
export const MAX_TEXT = 300;

/** Untrusted text as one line, cut to `max` characters. */
export function clip(s: string, max = MAX_TEXT): string {
  const t = printable(s);

  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Proposals as the PROPOSALS Lens shows them, without its frame. */
export const proposalsLens = (proposals: Proposal[]) =>
  untrustedLens({ yea: 1, id: '-', re: '-', kind: 'PROPOSALS', proposals });

/** A reply as a tool result: its Lens, `isError` for an ERROR, and `structured` as data. */
export function replyResult(
  reply: Reply,
  structured?: Obj,
  extra: string[] = [],
): CallToolResult {
  return {
    ...textResult([untrustedLens(reply), ...extra], structured),
    ...(reply.kind === 'ERROR' ? { isError: true } : {}),
  };
}

/** A proposal as data for `structuredContent`: never its `data`, which may be large. */
export const proposalView = ({ data: _d, ...p }: Proposal) => oneLine(p) as Obj;
