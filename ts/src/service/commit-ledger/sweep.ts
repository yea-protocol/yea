/** Bounding the ledger's memory: forget expired proposals and old receipts. */
import { DAY } from '../../util.js';
import type { Records } from './records.js';

/**
 * Forget proposals an hour past expiry that no commit is running or ran, and receipts (with
 * their proposal, run and undo) a day after their undo window.
 */
export function sweep(r: Records, now: number) {
  for (const [id, s] of r.proposals) {
    if (s.proposal.expires < now - 3600 && !r.runs.has(id)) {
      r.proposals.delete(id);
    }
  }

  for (const [id, s] of r.receipts) {
    if ((s.receipt.undo?.until ?? s.receipt.at) + DAY < now) {
      r.receipts.delete(id);
      r.undos.delete(id);
      r.runs.delete(s.receipt.proposal);
      r.proposals.delete(s.receipt.proposal);
    }
  }
}
