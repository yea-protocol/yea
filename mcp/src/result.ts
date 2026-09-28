/**
 * Tool results and annotations the job plugin and the bridge share (SPEC-mcp-ts, "Results and
 * annotations"), and a job tool's risk metadata. `textResult` and `errorResult` are public, for a
 * server's own read tools.
 */
import type {
  CallToolResult,
  ToolAnnotations,
} from '@modelcontextprotocol/server';
import type { Risk } from '@yea-protocol/sdk';
import type { Obj } from './util.js';

/** A job changes things: destructive, so clients shouldn't auto-approve it. Hints only. */
export const JOB_ANNOTATIONS = Object.freeze({
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
}) satisfies ToolAnnotations;

/** `undo` changes things too, but undoing a receipt twice does nothing more. */
export const UNDO_ANNOTATIONS = Object.freeze({
  ...JOB_ANNOTATIONS,
  idempotentHint: true,
}) satisfies ToolAnnotations;

/** The tool's risk metadata (SPEC-mcp-ts, "Risk metadata"). */
export const jobMeta = (risk: Risk | undefined, undoable: boolean) => ({
  'dev.yea/job': { risk: risk ?? 'medium', undoable },
});

/** A job changes things: destructive unless the author says otherwise. Hints, not enforcement. */
export const jobAnnotations = (
  a: ToolAnnotations | undefined,
): ToolAnnotations => ({
  ...JOB_ANNOTATIONS,
  ...a,
});

/** A read never changes anything. */
export const READ_ANNOTATIONS = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
}) satisfies ToolAnnotations;

/** What every refusal says, so the model knows nothing happened. */
export const NOTHING_RAN = 'nothing was run';

const text = (lines: string[]) => [
  { type: 'text' as const, text: lines.join('\n') },
];

/** Lines of text for the model, and `structured` as data. */
export function textResult(lines: string[], structured?: Obj): CallToolResult {
  return {
    content: text(lines),
    ...(structured ? { structuredContent: structured } : {}),
  };
}

/** A refusal or failure: `isError`, so the model sees the reason and the fix. */
export function errorResult(lines: string[], structured?: Obj): CallToolResult {
  return { ...textResult(lines, structured), isError: true };
}

/** `✗ <why>; nothing was run`, then any lines that help. */
export const refused = (why: string, more: string[] = [], structured?: Obj) =>
  errorResult([`✗ ${why}; ${NOTHING_RAN}`, ...more], structured);
