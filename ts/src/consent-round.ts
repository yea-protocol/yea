/**
 * The consent round (GLOSSARY.md): what an agent does when a commit comes back
 * `consent_required` (SPEC.md §6.6). It commits, checks the service's consent request against
 * the proposal the agent was shown, asks an approver for a consent to the request it builds from
 * that proposal, checks the grant it gets back signs exactly that, and commits once more. A
 * consent that has expired, before the ask or by the answer, is refused and never sent.
 *
 * The principal key never enters it: an approver (approvers.ts) signs, or declines, or hands
 * back a consent code for `yea approve`. A consent store holds consents given somewhere else,
 * which the round tries before asking. Its parts live in consent-round/, private to this file.
 */

import type { Client, WithLens } from './client.js';
import { expiredWhy } from './consent.js';
import {
  type Asked,
  type AskWords,
  askConsent,
  type Expiry,
} from './consent-round/ask.js';
import { consentLines } from './consent-round/check.js';
import { keyPair } from './crypto.js';
import { printable } from './text.js';
import type {
  ConsentRequest,
  ErrorReply,
  Event,
  Proposal,
  ReceiptReply,
} from './types.js';
import { unixNow } from './util.js';

export { checkProposal } from './consent-round/check.js';

export {
  approveCode,
  keyFingerprint,
  NO_DETAIL,
} from './consent-round/code.js';

/** What an approver is asked: the exact consent to give, and what to show the person. */
export interface ConsentAsk {
  /** The consent to sign: built from `proposal`, never taken from the service's request. */
  request: ConsentRequest;
  /** The proposal it's for, as the agent was shown it, its hash checked. */
  proposal: Proposal;
  /** The key the consent is issued to: the agent that commits with it. */
  agent: string;
  /** What to show the person: where, then the proposal's Lens; every line escaped. */
  lines: string[];
  /** Why the service asks (its error message), escaped; empty for a consent code. */
  reason: string;
}

/** An approver's answer: a signed consent grant, a decline, or a consent code to approve elsewhere. */
export type ConsentAnswer =
  | { grant: string }
  | { declined: true }
  | { pending: string };

/** Asks for a consent; the round checks whatever grant comes back before it's used. */
export type Approver = (ask: ConsentAsk) => Promise<ConsentAnswer>;

/**
 * Consents given somewhere else, by the proposal hash they commit. The round trusts what `get`
 * returns: it sends it on the first COMMIT unchecked (unlike an approver's grant), leaving the
 * check to the service. That's safe, since a consent is issued to one agent key and names one
 * proposal hash; a store that must refuse some consents (the bridge's) checks them in `get`.
 */
export interface ConsentStore {
  get(hash: string): string | null | Promise<string | null>;
  put(hash: string, token: string): void;
}

/** A COMMIT's final reply. */
export type CommitReply = WithLens<ReceiptReply | ErrorReply>;

/**
 * How a round ended. `reply` is a COMMIT's reply, from the first try or the one retry, and
 * `consent` the consent grant it carried; a retry that again needs consent ends here too, never
 * in a second round. The others carry the first `consent_required`. `saved` is the stored
 * consent the first COMMIT carried, if any. A refusal is `expired` when the consent ran out and
 * nothing else was wrong: when it expired, and the round's clock then, for a caller that says
 * what to do in its own words.
 */
export type RoundOutcome = { saved: string | null } & (
  | { kind: 'reply'; reply: CommitReply; consent: string | null }
  | { kind: 'refused'; why: string; expired?: Expiry; reply: ErrorReply }
  | { kind: 'declined'; reply: ErrorReply }
  | { kind: 'pending'; code: string; reply: ErrorReply }
);

/** What a round commits with: the agent's key, the service's id, and COMMIT. */
export type RoundClient = Pick<Client, 'key' | 'audience' | 'commit'>;

export interface RoundOptions {
  client: RoundClient;
  /** The proposal as the agent was shown it: what the person consents to. */
  proposal: Proposal;
  approver: Approver;
  /** Where consents given elsewhere are found, and a new one is kept. */
  consents?: ConsentStore;
  onEvent?: (e: WithLens<Event>) => void;
  /**
   * The clock, in seconds, that the consent's expiry and its grant are checked by. The system's
   * by default.
   */
  now?: () => number;
}

/** How the live round says why it refused; `yea approve` has its own words for a code. */
const ROUND_WORDS: AskWords = {
  expired: (expires, now) =>
    expiredWhy('consent request', expires, now, 'Commit again for a fresh one'),
  mismatch: (why) => why,
  unusable: (why) => `the consent the approver gave can't be used: ${why}`,
};

/**
 * Ask for a consent to the first reply's consent request, or say why not: the service sent no
 * request, or the agent has no key. The rest is the ask step's (consent-round/ask.ts).
 */
async function askFirst(first: ErrorReply, o: RoundOptions): Promise<Asked> {
  const k = first.consent;
  const key = o.client.key;

  if (!k) {
    return { kind: 'refused', why: 'the service sent no consent request' };
  }

  if (!key) {
    return {
      kind: 'refused',
      why: 'the agent has no key to commit a consent with',
    };
  }

  return askConsent({
    request: k,
    proposal: o.proposal,
    service: await o.client.audience(),
    build: async () => ({
      agent: (await keyPair(key)).public,
      lines: consentLines(k, o.proposal),
      reason: printable(first.message),
    }),
    approver: o.approver,
    clock: o.now ?? unixNow,
    words: ROUND_WORDS,
  });
}

/** Ask the approver, and commit once more with the grant it gives. */
async function askAndRetry(
  first: ErrorReply,
  saved: string | null,
  o: RoundOptions,
): Promise<RoundOutcome> {
  const asked = await askFirst(first, o);

  if (asked.kind !== 'grant') {
    return { ...asked, reply: first, saved };
  }

  // Kept before the retry, so a COMMIT that fails in transport can be tried again with it. One
  // the service then refuses stays kept; the next round sends it, gets consent_required, and asks.
  o.consents?.put(asked.ask.request.hash, asked.grant);

  const reply = await o.client.commit(o.proposal, {
    grants: [asked.grant],
    onEvent: o.onEvent,
  });

  return { kind: 'reply', reply, consent: asked.grant, saved };
}

/**
 * Commit `proposal` with any consent the store keeps for it; if the service still wants the
 * person's consent, run one round: check, ask, check the grant, and commit once more.
 */
export async function consentRound(o: RoundOptions): Promise<RoundOutcome> {
  const saved = (await o.consents?.get(o.proposal.hash)) ?? null;
  const first = await o.client.commit(o.proposal, {
    grants: saved ? [saved] : [],
    onEvent: o.onEvent,
  });

  if (first.kind === 'ERROR' && first.code === 'consent_required') {
    return askAndRetry(first, saved, o);
  }

  return { kind: 'reply', reply: first, consent: saved, saved };
}

/** A consent store in memory: for tests, and pages that keep nothing. */
export function memoryConsents(): ConsentStore {
  const kept = new Map<string, string>();

  return {
    get: (hash) => kept.get(hash) ?? null,
    put: (hash, token) => {
      kept.set(hash, token);
    },
  };
}
