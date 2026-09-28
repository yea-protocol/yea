/** Bounds a service's memory by periodically forgetting expired proposals, old receipts and stale auto-INTENT replays. */
import { DAY, type ServiceState } from './state.js';

export class Sweeper {
  constructor(
    private readonly state: Pick<
      ServiceState,
      'proposals' | 'commits' | 'receipts' | 'autoSeen'
    >,
  ) {}

  private sweeps = 0;
  /** Bound memory: forget expired uncommitted proposals, and receipts a day after their undo window. */
  sweep(now: number) {
    if (++this.sweeps % 100 !== 0 && this.state.proposals.size < 5000) {
      return;
    }

    for (const [id, s] of this.state.proposals) {
      if (s.proposal.expires < now - 3600 && !this.state.commits.has(id)) {
        this.state.proposals.delete(id);
      }
    }

    for (const [id, r] of this.state.receipts) {
      if ((r.receipt.undo?.until ?? r.receipt.at) + DAY < now) {
        this.state.receipts.delete(id);
        this.state.commits.delete(r.receipt.proposal);
        this.state.proposals.delete(r.receipt.proposal);
      }
    }

    for (const [k, v] of this.state.autoSeen) {
      if (v.exp <= now) {
        this.state.autoSeen.delete(k);
      }
    }
  }
}
