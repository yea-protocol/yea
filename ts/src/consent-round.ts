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
import { requestExpired } from './consent.js';
import {
  checkConsentRequest,
  consentFrom,
  consentLines,
} from './consent-round/check.js';
import { grantMismatch } from './consent-round/grant.js';
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
 * consent the first COMMIT carried, if any. A refusal is `expired` when time ran out and nothing
 * else was wrong, so a fresh proposal may go through.
 */
export type RoundOutcome = { saved: string | null } & (
  | { kind: 'reply'; reply: CommitReply; consent: string | null }
  | { kind: 'refused'; why: string; expired?: true; reply: ErrorReply }
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
   * The clock, in seconds: the one the consent's expiry and the grant check are both read by. The
   * system's by default.
   */
  now?: () => number;
}

/** Why a round can't go on; `expired` as in `RoundOutcome`. */
interface Refusal {
  why: string;
  expired?: true;
}

/** The refusal for a consent to `request` that has expired at `now`, or null while it's valid. */
function expiry(request: ConsentRequest, now: number): Refusal | null {
  const why = requestExpired(request.expires, now);

  return why ? { why, expired: true } : null;
}

/**
 * The ask for the first reply's consent request, or why there is none: the service sent no
 * request, the agent has no key, the request doesn't name the proposal shown, or the consent it
 * asks for has expired by `clock`. A request that names something else is refused for that first.
 */
async function askFor(
  first: ErrorReply,
  o: RoundOptions,
  clock: () => number,
): Promise<ConsentAsk | Refusal> {
  const k = first.consent;
  const p = o.proposal;

  if (!k) {
    return { why: 'the service sent no consent request' };
  }

  if (!o.client.key) {
    return { why: 'the agent has no key to commit a consent with' };
  }

  const why = await checkConsentRequest(k, p, await o.client.audience());

  if (why) {
    return { why };
  }

  const request = consentFrom(k, p);
  const expired = expiry(request, clock());

  if (expired) {
    return expired;
  }

  return {
    request,
    proposal: p,
    agent: (await keyPair(o.client.key)).public,
    lines: consentLines(k, p),
    reason: printable(first.message),
  };
}

/**
 * Why the approver's grant for `ask` can't be used at `now`, or null if it can. The person may
 * have read for a while: a consent that expired meanwhile is refused as that, before the grant
 * check would call it an expired grant.
 */
async function grantRefusal(
  grant: string,
  ask: ConsentAsk,
  now: number,
): Promise<Refusal | null> {
  const expired = expiry(ask.request, now);

  if (expired) {
    return expired;
  }

  const bad = await grantMismatch(grant, ask, now);

  return bad
    ? { why: `the consent the approver gave can't be used: ${bad}` }
    : null;
}

/** Ask the approver, check its grant, and commit once more with it. */
async function askAndRetry(
  first: ErrorReply,
  saved: string | null,
  o: RoundOptions,
): Promise<RoundOutcome> {
  const clock = o.now ?? unixNow;
  const ask = await askFor(first, o, clock);

  if ('why' in ask) {
    return { kind: 'refused', ...ask, reply: first, saved };
  }

  const a = await o.approver(ask);

  if ('pending' in a) {
    return { kind: 'pending', code: a.pending, reply: first, saved };
  }

  if (!('grant' in a)) {
    return { kind: 'declined', reply: first, saved };
  }

  const bad = await grantRefusal(a.grant, ask, clock());

  if (bad) {
    return { kind: 'refused', ...bad, reply: first, saved };
  }

  // Kept before the retry, so a COMMIT that fails in transport can be tried again with it. One
  // the service then refuses stays kept; the next round sends it, gets consent_required, and asks.
  o.consents?.put(ask.request.hash, a.grant);

  const reply = await o.client.commit(o.proposal, {
    grants: [a.grant],
    onEvent: o.onEvent,
  });

  return { kind: 'reply', reply, consent: a.grant, saved };
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
