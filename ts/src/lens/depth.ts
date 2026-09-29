/**
 * How deep Lens renders (SPEC §9.1, depth): objects and arrays nested past MAX_DEPTH render as
 * `…`, so a deeply nested value can't overflow the stack in any implementation.
 */
import { isObject } from '../util.js';

/** The levels of objects and arrays Lens renders below the value (or frame) it's given. */
export const MAX_DEPTH = 64;

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
