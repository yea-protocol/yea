/** How a proposal's `uses` counts against an `each` or `total` limit (SPEC §6.3), and how a limit reads. */
import { fmtDuration } from '../lens.js';
import {
  exact,
  fmtQuantity,
  type Limit,
  limitQuantity,
  sameUnit,
  type Uses,
} from '../uses.js';
import type { CheckContext } from './context.js';

/** The proposal's quantity of measure `of`, if it reports one. */
export function usedOf(uses: Uses | undefined, of: string) {
  return uses && Object.hasOwn(uses, of) ? uses[of] : undefined;
}

/** A limit as Lens renders it (SPEC §9.2): `500.00 USD`, or `500.00 USD every 7d`. */
export function fmtLimit(l: Limit): string {
  const max = fmtQuantity(limitQuantity(l));

  return l.every === undefined ? max : `${max} every ${fmtDuration(l.every)}`;
}

/**
 * Why the proposal's use of `l.of`, on top of `already`, breaks the limit `l` (SPEC §6.3);
 * null if it doesn't. `breaks` says how, given the limit as it reads. A proposal that doesn't
 * report the measure passes.
 */
export function overLimit(
  p: CheckContext['proposal'],
  l: Limit,
  already: bigint,
  breaks: (limit: string) => string,
): string | null {
  if (!p) {
    return null;
  }

  // `malformed` has already rejected a malformed `uses`.
  const q = usedOf(p.uses, l.of);

  if (!q) {
    return null;
  }

  if (!sameUnit(q, l)) {
    return `${l.of} is in ${q.unit ?? 'no unit'}, but the limit is in ${l.unit ?? 'no unit'}`;
  }

  return already + exact(q) > exact({ amount: l.max, scale: l.scale })
    ? `${l.of} ${breaks(fmtLimit(l))}`
    : null;
}
