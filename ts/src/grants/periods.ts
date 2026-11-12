/**
 * Periods (SPEC §6.3): a `total` with `every` counts in fixed periods from the one `nbf` of its
 * block. Which period a time falls in, where a commit counts, and when the next period starts.
 */
import { isLensTime } from '../lens.js';
import { isTotal, type Limit } from '../uses.js';
import { isObject, isSafeInt } from '../util.js';
import type { LedgerKey, Period } from './context.js';

/** A block's caveats, decoded but not yet validated. */
interface Caveats {
  caveats: unknown[];
}

/** The values of the caveats named `k` in a block. */
const valuesOf = (b: Caveats, k: string): unknown[] =>
  b.caveats.flatMap((c) => (isObject(c) && Object.hasOwn(c, k) ? [c[k]] : []));

/** A block's one `nbf`, which its periodic totals count from; null with none, several, or a malformed one. */
export function anchorOf(b: Caveats): number | null {
  const [nbf, ...more] = valuesOf(b, 'nbf');

  return more.length === 0 && isSafeInt(nbf) ? nbf : null;
}

/** The earliest `exp` in `blocks`; for all of a grant's, when it and its last period end. Null with none. */
export function endOf(blocks: Caveats[]): number | null {
  const exps = blocks.flatMap((b) => valuesOf(b, 'exp')).filter(isSafeInt);

  return exps.length ? Math.min(...exps) : null;
}

/** The period of `every` seconds counted from `anchor` that `t` is in; null before `anchor`. */
export function periodAt(
  anchor: number,
  every: number,
  t: number,
): Period | null {
  if (t < anchor) {
    return null;
  }

  // t − anchor can pass 2^53, so the offset into the period is worked out in exact integers. It
  // is less than both `every` and t − anchor, so the start, between anchor and t, is safe again.
  const into = (BigInt(t) - BigInt(anchor)) % BigInt(every);

  return { every, start: t - Number(into) };
}

/**
 * Where a COMMIT at `t` counts against `l`, a `total` of block `block` whose periods count from
 * `anchor`: its block and measure, and its period if it has `every`. Null before the anchor,
 * where the block's own `nbf` denies the request and the total counts nothing.
 */
export function ledgerKey(
  block: string,
  l: Limit,
  anchor: number | null,
  t: number,
): LedgerKey | null {
  if (l.every === undefined) {
    return { block, of: l.of };
  }

  const period = anchor === null ? null : periodAt(anchor, l.every, t);

  return period && { block, of: l.of, period };
}

/** The ledger keys a COMMIT at `t` reads: one for each well-formed `total` of each block. */
export function totalKeys(
  blocks: (Caveats & { id: string })[],
  t: number,
): LedgerKey[] {
  return blocks.flatMap((b) =>
    valuesOf(b, 'total')
      .filter(isTotal)
      .flatMap((l) => ledgerKey(b.id, l, anchorOf(b), t) ?? []),
  );
}

/**
 * When the period after `p` starts, if that is before the grant ends at `end` and a time Lens
 * can show (SPEC §9.2); otherwise null. Worked out in exact integers: it can pass 2^53.
 */
export function nextStart(p: Period, end: number | null): number | null {
  // Number() rounds only past 2^53, far beyond any time Lens shows.
  const next = Number(BigInt(p.start) + BigInt(p.every));

  return isLensTime(next) && (end === null || next < end) ? next : null;
}
