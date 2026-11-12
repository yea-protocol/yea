/**
 * How `yea grant`, `yea delegate` and `yea inspect` describe a `total` that counts in periods
 * (SPEC §6.3, §11): when its periods start, when they end, and the most it allows in all.
 */
import { anchorOf, endOf, fmtLimit } from '../grants.js';
import { fmtTime } from '../lens.js';
import { fmtAmount, isTotal, type Limit } from '../uses.js';
import { isObject } from '../util.js';

/** A block's caveats, decoded but not yet validated. */
interface Caveats {
  caveats: unknown[];
}

type Periodic = Limit & { every: number };

/** The most `l` allows from `anchor` to `end`: its max in every period that starts before `end`. */
function worstCase(l: Periodic, anchor: number, end: number): string {
  // end − anchor can pass 2^53 (an nbf near −2^53), so the span is worked out in exact integers.
  const span = BigInt(end) - BigInt(anchor);
  const every = BigInt(l.every);
  const periods = span > 0n ? (span + every - 1n) / every : 0n;

  return fmtAmount(BigInt(l.max) * periods, l.scale ?? 0, l.unit);
}

/** Where a periodic total's block sits: its anchor, its block-or-earlier `exp`, and the grant's end. */
interface Placed {
  anchor: number | null;
  bound: number | null;
  end: number | null;
}

/** One line for a periodic total, placed in its grant. */
function periodLine(l: Periodic, { anchor, bound, end }: Placed): string {
  const head = `${l.of}: ${fmtLimit(l)}`;

  if (anchor === null) {
    return `${head}, refused everywhere: its block has no single nbf to count from`;
  }

  // An exp in the block or an earlier one ends its periods, so `end`, the grant's earliest, is set.
  return bound === null || end === null
    ? `${head}, refused everywhere: neither its block nor an earlier one has an exp to end it`
    : `${head} from ${fmtTime(anchor)} until ${fmtTime(end)}, at most ${worstCase(l, anchor, end)}`;
}

/** The periodic totals among a block's caveats. */
const periodicTotals = (b: Caveats): Periodic[] =>
  b.caveats.flatMap((c) => {
    const l = isObject(c) ? c.total : undefined;

    return isTotal(l) && l.every !== undefined
      ? [{ ...l, every: l.every }]
      : [];
  });

/**
 * A line for each `total` with `every` in block `i` of a grant's `blocks`, such as
 * `buy: 500 USD every 7d from 2026-11-11T00:00Z until 2027-02-09T16:20Z, at most 6500 USD`.
 * "until" is the grant's earliest `exp`, in any block.
 */
export function periodLines(blocks: Caveats[], i: number): string[] {
  const placed = {
    anchor: anchorOf(blocks[i]),
    bound: endOf(blocks.slice(0, i + 1)),
    end: endOf(blocks),
  };

  return periodicTotals(blocks[i]).map((l) => periodLine(l, placed));
}
