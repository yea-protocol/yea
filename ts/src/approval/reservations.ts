/** Reservations against a policy's `total` limits (SPEC-approval §5): what an auto-run needs, taken all or nothing. */
import { type TotalLimit, usedOf } from '../grants.js';
import {
  type ApprovalStore,
  type LedgerKey,
  ledgerId,
  type Reservation,
} from '../store.js';
import { exact } from '../uses.js';
import type { HashedPlan } from './plans.js';

/**
 * One reservation an auto-run needs: the ledger entry, with the period `decide` checked when the
 * `total` has `every`, how much, and the smallest `max`.
 */
export interface ReserveFor {
  key: LedgerKey;
  amount: bigint;
  max: bigint;
}

/**
 * One reservation per ledger key the plan uses; a repeated `total` keeps its smallest `max`.
 * Totals on one measure with a different `every` have different keys, so each reserves.
 */
export function reservationsFor(
  hp: HashedPlan,
  totals: TotalLimit[],
): ReserveFor[] {
  const out = new Map<string, ReserveFor>();

  for (const { key, max } of totals) {
    const q = usedOf(hp.plan.uses, key.of);
    const id = ledgerId(key);
    const seen = out.get(id);

    if (!q) {
      continue;
    }

    if (!seen || max < seen.max) {
      out.set(id, { key, amount: exact(q), max });
    }
  }

  return [...out.values()];
}

/**
 * Reserve everything an auto-run needs, all or nothing (SPEC-approval §5). Null means one
 * would pass its limit: the ones already made are released and the call should ask instead.
 */
export async function reserveAll(
  store: ApprovalStore,
  wanted: ReserveFor[],
): Promise<Reservation[] | null> {
  const made: Reservation[] = [];
  const undo = () => Promise.all(made.map((m) => store.release(m)));

  try {
    for (const w of wanted) {
      const r = await store.reserve(w.key, w.amount, w.max);

      if (!r) {
        await undo();

        return null;
      }

      made.push(r);
    }
  } catch (e) {
    await undo();

    throw e;
  }

  return made;
}
