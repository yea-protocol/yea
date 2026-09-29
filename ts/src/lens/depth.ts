/**
 * How deep Lens renders (SPEC §9.1, depth): objects and arrays nested past MAX_DEPTH render as
 * `…`, so a deeply nested value can't overflow the stack in any implementation.
 */
import { isObject } from '../util.js';

/**
 * The levels of objects and arrays Lens renders below the value (or frame) it's given. It stays
 * above a BRIEF param schema's reach (frame level 3 + MAX_PARAM_DEPTH in shape.ts), so a schema is
 * judged by its own limit, never by the cut.
 */
export const MAX_DEPTH = 64;

/**
 * How deep what a person approves may nest (SPEC §6.6): a proposal without its `data`, or a
 * plan's summary, effects and uses, itself being the first level. No view puts it more than two
 * levels into its frame, so it always shows in full: approval never covers content cut to `…`.
 */
export const MAX_APPROVAL_DEPTH = 32;

/** What an object or array nested past MAX_DEPTH becomes: a string, so it renders as one. */
const CUT = '…';

/**
 * `v` with every object or array MAX_DEPTH levels below it replaced by `…`. It recurses at most
 * MAX_DEPTH deep, and keeps key order.
 */
export function clipDepth(v: unknown, depth = 0): unknown {
  if (Array.isArray(v)) {
    return depth < MAX_DEPTH ? v.map((x) => clipDepth(x, depth + 1)) : CUT;
  }

  if (isObject(v)) {
    return depth < MAX_DEPTH
      ? Object.fromEntries(
          Object.entries(v).map(([k, x]) => [k, clipDepth(x, depth + 1)]),
        )
      : CUT;
  }

  return v;
}

/**
 * True when `v` holds an object or array `levels` or more levels below it (`v` is level 0), so
 * clipping it to that many levels would cut something. It recurses at most `levels` deep.
 */
export function nestedPast(v: unknown, levels: number, depth = 0): boolean {
  if (!Array.isArray(v) && !isObject(v)) {
    return false;
  }

  return (
    depth >= levels ||
    Object.values(v).some((x) => nestedPast(x, levels, depth + 1))
  );
}

/** True when `v`, something a person would approve, nests past MAX_APPROVAL_DEPTH. */
export const tooDeepToApprove = (v: unknown): boolean =>
  nestedPast(v, MAX_APPROVAL_DEPTH);
