/** Reply envelopes a service writes (SPEC §2): shared by the service and its transports. */
import { randomId } from './crypto.js';
import type { Kind } from './types.js';

/** The request id an error reply should answer: the frame's `id` if it has a string one, else '?'. */
export function frameId(frame: unknown): string {
  const id = (frame as { id?: unknown } | null | undefined)?.id;

  return typeof id === 'string' ? id : '?';
}

/**
 * A reply to request `re`: `yea`, a fresh id, `re` and `kind`, then the kind's own fields.
 * The key order is what goes on the wire, so every reply is built here.
 */
export const replyFrame = <K extends Kind, B extends object>(
  re: string,
  kind: K,
  body: B,
) => ({ yea: 1 as const, id: randomId('s', 6), re, kind, ...body });

interface ErrorFields {
  id: string;
  re: string;
  code: string;
  message: string;
  retry?: number;
}

/** One NDJSON ERROR line a transport writes itself, with a fixed id (`s_err`, `s_busy`). */
export const errorLine = ({ id, re, code, message, retry }: ErrorFields) =>
  `${JSON.stringify({ yea: 1, id, re, kind: 'ERROR', code, message, retry })}\n`;
