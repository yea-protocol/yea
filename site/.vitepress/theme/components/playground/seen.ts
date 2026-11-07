/**
 * What the agent has seen so far (proposals, receipts and handles), so COMMIT, UNDO and
 * EXPAND can pick one, and the options the request form lists for each of those verbs.
 */
import type {
  FinalReply,
  More,
  Proposal,
  Receipt,
  Verb,
} from '@yea-protocol/sdk';
import type { Core, Exchange, ServiceKey } from './model';

/** A proposal from a PROPOSALS reply. */
export interface ReceivedProposal extends Proposal {
  service: ServiceKey;
  committed?: never;
}

/** A proposal the service auto-committed: known only from its receipt, so it can't be committed. */
export interface AutoCommitted {
  id: string;
  summary: string;
  hash: '';
  service: ServiceKey;
  committed: true;
}

export type SeenProposal = ReceivedProposal | AutoCommitted;

export interface SeenReceipt extends Receipt {
  service: ServiceKey;
}

export interface SeenHandle extends More {
  service: ServiceKey;
}

/** Newest first. */
export interface Seen {
  proposals: SeenProposal[];
  receipts: SeenReceipt[];
  handles: SeenHandle[];
}

/** One option in the proposal, receipt or handle picker. */
export interface Target {
  value: string;
  label: string;
  committed: boolean;
}

export const emptySeen = (): Seen => ({
  proposals: [],
  receipts: [],
  handles: [],
});

/** The handles a reply offers for more. */
export const moreOf = (r: FinalReply): More[] =>
  'more' in r ? (r.more ?? []) : [];

/**
 * The receipt a reply offers an Undo for, or null: one that isn't an undo itself and was
 * committed with an undo window, by the SDK's rule (`until` minus `at`), so a window that isn't a
 * positive integer offers none (#83).
 */
export function undoOffer(
  kit: Pick<Core, 'isUndoWindow'>,
  r: FinalReply,
): string | null {
  if (r.kind !== 'RECEIPT' || r.receipt.undoes || !r.receipt.undo) {
    return null;
  }

  return kit.isUndoWindow(r.receipt.undo.until - r.receipt.at)
    ? r.receipt.id
    : null;
}

/** Note what a reply from `service` gave the agent. */
export function remember(seen: Seen, service: ServiceKey, r: FinalReply) {
  if (r.kind === 'PROPOSALS') {
    for (const p of r.proposals) {
      seen.proposals.unshift({ ...p, service });
    }
  }

  if (r.kind === 'RECEIPT' && !r.replay) {
    if (!r.receipt.undoes) {
      seen.receipts.unshift({ ...r.receipt, service });
    }

    if (r.auto) {
      const { proposal: id, summary } = r.receipt;

      seen.proposals.unshift({
        id,
        summary,
        hash: '',
        service,
        committed: true,
      });
    }
  }

  for (const m of moreOf(r)) {
    seen.handles.unshift({ ...m, service });
  }
}

const proposalTarget = (p: SeenProposal): Target => ({
  value: p.id,
  label: p.summary,
  committed: Boolean(p.committed),
});

const receiptTarget = (r: SeenReceipt): Target => ({
  value: r.id,
  label: r.summary,
  committed: false,
});

const handleTarget = (h: SeenHandle): Target => ({
  value: h.handle,
  label: `${h.remaining} more at ${h.path}`,
  committed: false,
});

/** What `verb` can pick at `service`: nothing for the other verbs. */
export function targetsOf(
  seen: Seen,
  verb: Verb,
  service: ServiceKey,
): Target[] {
  const at = <T extends { service: ServiceKey }>(list: T[]) =>
    list.filter((x) => x.service === service);

  switch (verb) {
    case 'COMMIT':
      return at(seen.proposals).map(proposalTarget);
    case 'UNDO':
      return at(seen.receipts).map(receiptTarget);
    case 'EXPAND':
      return at(seen.handles).map(handleTarget);
    default:
      return [];
  }
}

/**
 * The INTENT whose PROPOSALS held the proposal that `x` commits, and its place in them: where
 * to ask again from after a decline. Null for anything else.
 */
export function proposedBy(
  log: readonly Pick<Exchange, 'request' | 'reply'>[],
  x: Pick<Exchange, 'request'>,
): { intent: Pick<Exchange, 'request' | 'reply'>; at: number } | null {
  const id = x.request.verb === 'COMMIT' ? x.request.proposal : null;

  for (const e of [...log].reverse()) {
    const at =
      e.request.verb === 'INTENT' && e.reply.kind === 'PROPOSALS'
        ? e.reply.proposals.findIndex((p) => p.id === id)
        : -1;

    if (id && at >= 0) {
      return { intent: e, at };
    }
  }

  return null;
}
