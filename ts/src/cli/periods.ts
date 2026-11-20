/**
 * How `yea grant`, `yea delegate` and `yea inspect` describe a `total` that counts in periods
 * (SPEC §6.3, §11): when its periods start, when they end, and the most it allows in all.
 */
import { anchorOf, endOf, fmtLimit } from '../grants.js';
import { fmtTime } from '../lens.js';
import { fmtAmount, isTotal, type Limit } from '../uses.js';
import { isObject, isStringList } from '../util.js';

/** A block's caveats, decoded but not yet validated. */
interface Caveats {
  caveats: unknown[];
}

type Periodic = Limit & { every: number };

/**
 * The most `l` allows at one service from `anchor` to `end`, in units of its scale: its max in
 * every period that starts before `end`.
 */
function worstCase(l: Periodic, anchor: number, end: number): bigint {
  // end − anchor can pass 2^53 (an nbf near −2^53), so the span is worked out in exact integers.
  const span = BigInt(end) - BigInt(anchor);
  const every = BigInt(l.every);
  const periods = span > 0n ? (span + every - 1n) / every : 0n;

  return BigInt(l.max) * periods;
}

/**
 * The services a grant's `svc` caveats leave, across all its blocks: null with none, when every
 * service that trusts its principal accepts it.
 */
function servicesOf(blocks: Caveats[]): string[] | null {
  const lists = blocks.flatMap((b) =>
    b.caveats.flatMap((c) =>
      isObject(c) && isStringList(c.svc) ? [c.svc] : [],
    ),
  );
  const [first, ...rest] = lists;

  return first
    ? [...new Set(first)].filter((s) => rest.every((l) => l.includes(s)))
    : null;
}

/**
 * `at most …`, and where. A `total` counts at each service on its own (SPEC §6.3), so the most is
 * per service unless the grant's `svc` caveats leave one, with the sum when they name several.
 */
function atMost(l: Periodic, worst: bigint, services: string[] | null): string {
  const shown = (n: bigint) => fmtAmount(n, l.scale ?? 0, l.unit);

  if (services === null) {
    return `at most ${shown(worst)} at each service`;
  }

  const n = services.length;

  return n === 1
    ? `at most ${shown(worst)}`
    : `at most ${shown(worst)} at each of its ${n} services, ${shown(worst * BigInt(n))} in all`;
}

/**
 * Where a periodic total's block sits: its anchor, its block-or-earlier `exp`, the grant's end,
 * and the services it can be used at.
 */
interface Placed {
  anchor: number | null;
  bound: number | null;
  end: number | null;
  services: string[] | null;
}

/** One line for a periodic total, placed in its grant. */
function periodLine(
  l: Periodic,
  { anchor, bound, end, services }: Placed,
): string {
  const head = `${l.of}: ${fmtLimit(l)}`;

  if (anchor === null) {
    return `${head}, refused everywhere: its block has no single nbf to count from`;
  }

  // An exp in the block or an earlier one ends its periods, so `end`, the grant's earliest, is set.
  if (bound === null || end === null) {
    return `${head}, refused everywhere: neither its block nor an earlier one has an exp to end it`;
  }

  if (services?.length === 0) {
    return `${head}, refused everywhere: its svc caveats leave no service`;
  }

  return `${head} from ${fmtTime(anchor)} until ${fmtTime(end)}, ${atMost(l, worstCase(l, anchor, end), services)}`;
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
 * A line for each `total` with `every` in block `i` of a grant's `blocks`, such as `buy: 500 USD
 * every 7d from 2026-11-11T00:00Z until 2027-02-09T16:20Z, at most 6500 USD at each service`.
 * "until" is the grant's earliest `exp`, in any block.
 */
export function periodLines(blocks: Caveats[], i: number): string[] {
  const placed = {
    anchor: anchorOf(blocks[i]),
    bound: endOf(blocks.slice(0, i + 1)),
    end: endOf(blocks),
    services: servicesOf(blocks),
  };

  return periodicTotals(blocks[i]).map((l) => periodLine(l, placed));
}
