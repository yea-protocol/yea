/** Receipt ids and undoing a job (SPEC-approval §7): within its window, for the same principal, once. */
import { randomId } from '../crypto.js';
import type { ApprovalStore, JobReceipt } from '../store.js';

/** Receipt ids are `r_` and 8 to 32 b64url characters; anything else never reaches the store. */
export const isReceiptId = (id: unknown): id is string =>
  typeof id === 'string' && /^r_[A-Za-z0-9_-]{8,32}$/.test(id);

export const newReceiptId = () => randomId('r');

export type UndoOutcome =
  | { kind: 'undone'; receipt: JobReceipt }
  | { kind: 'refused'; why: string };

/**
 * Undo a job (SPEC-approval §7): within its window, for the same principal, once. The tool's
 * `revert` gets what the receipt stored, so any process can undo it.
 */
export async function undoJob(
  store: ApprovalStore,
  opts: {
    id: unknown;
    /** This server's service id: a receipt from another server sharing the store is unknown. */
    service: string;
    sub: string;
    now: number;
    revert: (r: JobReceipt) => unknown;
  },
): Promise<UndoOutcome> {
  const found = isReceiptId(opts.id) ? await store.getReceipt(opts.id) : null;
  const r = found?.service === opts.service ? found : null;
  const why = undoRefusal(r, opts.sub, opts.now);

  if (why || !r) {
    return { kind: 'refused', why: why ?? 'no such receipt' };
  }

  if (!(await store.claimUndo(r.id))) {
    return { kind: 'refused', why: 'this job was already undone' };
  }

  try {
    await opts.revert(r);
  } catch (e) {
    await store.releaseUndo(r.id);

    throw e;
  }

  await store.markUndone(r.id);

  return { kind: 'undone', receipt: r };
}

function undoRefusal(
  r: JobReceipt | null,
  sub: string,
  now: number,
): string | null {
  if (!r || r.sub !== sub) {
    return 'no such receipt';
  }

  if (!r.undo) {
    return 'this job can never be undone';
  }

  // Open through `until` itself, as in the protocol's UNDO (SPEC.md §4.5).
  return now > r.undo.until ? 'the undo window has closed' : null;
}
