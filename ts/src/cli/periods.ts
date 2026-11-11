/**
 * How `yea grant` and `yea inspect` describe a `total` that counts in periods (SPEC §6.3, §11):
 * when its periods start, when they end, and the most it allows in all.
 */
import { anchorOf, fmtLimit } from '../grants.js';
import { fmtTime } from '../lens.js';
import { isTotal, type Limit } from '../uses.js';
import { isObject } from '../util.js';

/** An exact amount at `scale`, with its unit: a worst case can pass a quantity's 2^53 − 1. */
function fmtExact(amount: bigint, scale: number, unit?: string): string {
  const digits = String(amount).padStart(scale + 1, '0');
  const value = scale
    ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}`
    : digits;

  return unit ? `${value} ${unit}` : value;
}

/** The most `l` allows from `anchor` to `end`: its max in every period that starts before `end`. */
function worstCase(l: Limit & { every: number }, anchor: number, end: number) {
  const span = BigInt(Math.max(0, end - anchor));
  const periods = (span + BigInt(l.every) - 1n) / BigInt(l.every);

  return fmtExact(BigInt(l.max) * periods, l.scale ?? 0, l.unit);
}

/** One line for a periodic total of a block anchored at `anchor`, in a grant that ends at `end`. */
function periodLine(
  l: Limit & { every: number },
  anchor: number | null,
  end: number | null,
): string {
  const head = `${l.of}: ${fmtLimit(l)}`;

  if (anchor === null) {
    return `${head}, refused everywhere: its block has no single nbf to count from`;
  }

  return end === null
    ? `${head}, refused everywhere: the grant has no exp to end it`
    : `${head} from ${fmtTime(anchor)} until ${fmtTime(end)}, at most ${worstCase(l, anchor, end)}`;
}

/**
 * A line for each `total` with `every` in a block of a grant that ends at `end`, such as
 * `buy: 500 USD every 7d from 2026-11-11T00:00Z until 2027-02-09T16:20Z, at most 6500 USD`.
 */
export function periodLines(
  b: { caveats: unknown[] },
  end: number | null,
): string[] {
  const anchor = anchorOf(b);

  return b.caveats.flatMap((c) => {
    const l = isObject(c) ? c.total : undefined;

    return isTotal(l) && l.every !== undefined
      ? [periodLine({ ...l, every: l.every }, anchor, end)]
      : [];
  });
}
