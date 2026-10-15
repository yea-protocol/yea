/**
 * The playground's consent round: a COMMIT of a proposal the agent received goes through the
 * SDK's consent round, whose signer waits on the page for the human. The round checks the
 * service's request against that proposal and builds what the human signs from it; this file
 * only starts it and says where it stands. No Vue here, so it can be tested.
 */
import type {
  Client,
  ConsentAsk,
  ConsentRequest,
  KeyPair,
  RoundOutcome,
} from '@yea-protocol/sdk';
import type { Core } from './model.ts';
import type { ReceivedProposal } from './seen.ts';

/** Where the round stands: what the human signs once they approve, or why it can't be approved. */
export type ConsentCheck =
  | { state: 'checking' }
  | { state: 'ok'; consent: ConsentRequest }
  | { state: 'refused'; why: string };

/** A round waiting on the human: what they're asked, how to answer, and how it ends. */
export interface Waiting {
  ask: ConsentAsk;
  decide: (yes: boolean) => void;
  done: Promise<RoundOutcome>;
}

/** How a round's first stretch ended: it waits on the human, or it's already over. */
export type Started = { waiting: Waiting } | { out: RoundOutcome };

/**
 * Commit `proposal` through the consent round as the agent; the human's key signs only once
 * `decide(true)` is called. Resolves when the round waits on the human or ends.
 */
export function startRound(
  sdk: Pick<Core, 'consentRound' | 'signer'>,
  o: {
    client: Client;
    proposal: ReceivedProposal;
    principal: KeyPair;
    budget?: number;
  },
): Promise<Started> {
  const { service: _s, committed: _c, ...proposal } = o.proposal;
  const c = o.client;
  let asked: (w: Omit<Waiting, 'done'>) => void = () => undefined;
  const waiting = new Promise<Omit<Waiting, 'done'>>((r) => {
    asked = r;
  });
  const done = sdk.consentRound({
    client: {
      key: c.key,
      audience: () => c.audience(),
      commit: (p, x) => c.commit(p, { ...x, budget: o.budget }),
    },
    proposal,
    approver: sdk.signer(
      o.principal,
      (ask) => new Promise((decide) => asked({ ask, decide })),
    ),
  });

  return Promise.race([
    done.then((out) => ({ out })),
    waiting.then((w) => ({ waiting: { ...w, done } })),
  ]);
}

/** Where a started round stands, for the card: waiting with what's signed, or refused. */
export function checkOf(s: Started): ConsentCheck | null {
  if ('waiting' in s) {
    return { state: 'ok', consent: s.waiting.ask.request };
  }

  return s.out.kind === 'refused' ? { state: 'refused', why: s.out.why } : null;
}
