/**
 * Consent codes for `yea approve` (docs/framework/SPEC-approval.md §6): a job's
 * code when the client can't ask, and reading and signing one.
 */
import {
  consentHashOf,
  type HashedPlan,
  planHashOf,
  planPreimage,
  planTooDeep,
} from '../approval.js';
import {
  codeExpired,
  consentGrant,
  decodeConsentCode,
  encodeConsentCode,
} from '../consent.js';
import type { KeyPair } from '../crypto.js';
import { isRisk } from '../risk.js';
import { isStoreId } from '../store.js';
import type { ConsentRequest, Effect, Risk } from '../types.js';
import { isUses, type Uses } from '../uses.js';
import { unixNow } from '../util.js';
import { checkedPhrase } from './phrase.js';

/** A job consent code as `yea approve` may sign it: checked, with its expiry capped. */
export interface JobConsent {
  consent: ConsentRequest;
  /** The plan-hash preimage; its `undoWindow` is unchecked, so read it with `planLines`. */
  job: Record<string, unknown> & {
    tool: string;
    summary: string;
    effects: Effect[];
    uses?: Uses;
    risk: Risk;
  };
  phrase: string;
  /** The id of the store the consent will be consumed in, which the consent hash binds. */
  store: string;
  planHash: string;
}

export const CONSENT_TTL = 600;

/**
 * A job's consent code: the unsigned pc1. consent request, carrying the whole plan, its phrase
 * and the server's store id to re-check. `proposal` is the plan hash; `hash` is the consent hash,
 * which binds the phrase and the store. It throws unless `store` is a store id.
 */
export async function jobConsentCode(o: {
  server: string;
  principal: string;
  input: unknown;
  hp: HashedPlan;
  phrase: string;
  store: string;
  now: number;
  ttl?: number;
}): Promise<string> {
  if (!isStoreId(o.store)) {
    throw new Error(`not a store id: ${JSON.stringify(o.store)}`);
  }

  const detail = {
    job: planPreimage(o.input, o.hp),
    phrase: checkedPhrase(o.phrase),
    store: o.store,
  };
  const consent: ConsentRequest = {
    proposal: o.hp.planHash,
    hash: await consentHashOf(o.hp.planHash, detail.phrase, o.store),
    service: o.server,
    capability: o.hp.tool,
    principal: o.principal,
    summary: o.hp.plan.summary,
    expires: o.now + (o.ttl ?? CONSENT_TTL),
  };

  return encodeConsentCode({ ...consent, detail });
}

function isJob(j: unknown): j is JobConsent['job'] {
  const o = j as Partial<JobConsent['job']> | null;

  return (
    !!o &&
    typeof o.tool === 'string' &&
    typeof o.summary === 'string' &&
    Array.isArray(o.effects) &&
    (o.uses === undefined || isUses(o.uses)) &&
    isRisk(o.risk)
  );
}

/**
 * Read a job consent code for signing (§6). Everything shown or signed is checked: the phrase
 * must be typeable, the store a store id, the plan hash and the consent hash are recomputed from
 * the plan, the phrase and the store, the tool must be the plan's, and it must not have expired.
 * The expiry is capped at `CONSENT_TTL` from now, whatever the code asks for.
 */
export async function readJobConsent(
  code: string,
  now: number,
): Promise<JobConsent> {
  const c = decodeConsentCode(code);
  const d = c.detail as unknown as
    | { job?: unknown; phrase?: unknown; store?: unknown }
    | undefined;
  const job = d?.job;
  const store = d?.store;

  if (!isJob(job) || typeof d?.phrase !== 'string' || !isStoreId(store)) {
    throw new Error('not a job consent code');
  }

  if (planTooDeep(job)) {
    throw new Error(
      "this consent code's plan is nested too deep to show in full",
    );
  }

  const phrase = checkedPhrase(d.phrase, "this consent code's phrase");
  const planHash = await planHashOf(job);

  if (
    planHash !== c.proposal ||
    (await consentHashOf(planHash, phrase, store)) !== c.hash ||
    job.tool !== c.capability
  ) {
    throw new Error(
      "this consent code's plan or phrase doesn't match its hash",
    );
  }

  const expired = codeExpired(c.expires, now);

  if (expired) {
    throw new Error(expired);
  }

  const { detail: _d, ...consent } = c;

  return {
    consent: { ...consent, expires: Math.min(c.expires, now + CONSENT_TTL) },
    job,
    phrase,
    store,
    planHash,
  };
}

/**
 * The consent grant for a read job consent: signed by the principal, issued to the server. It's
 * signed only while the consent is valid at `now`, the time of signing by default: a person who
 * took longer to type the phrase gets a refusal, not a consent that has already expired.
 */
export async function signJobConsent(
  principal: KeyPair | string,
  j: JobConsent,
  now = unixNow(),
): Promise<string> {
  const expired = codeExpired(j.consent.expires, now);

  if (expired) {
    throw new Error(expired);
  }

  return consentGrant({
    principal,
    agent: j.consent.service,
    consent: j.consent,
  });
}
