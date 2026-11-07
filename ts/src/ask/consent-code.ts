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
  consentGrant,
  decodeConsentCode,
  encodeConsentCode,
} from '../consent.js';
import type { KeyPair } from '../crypto.js';
import { isRisk } from '../risk.js';
import type { ConsentRequest, Effect, Risk } from '../types.js';
import { isUses, type Uses } from '../uses.js';
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
  planHash: string;
}

export const CONSENT_TTL = 600;

/**
 * A job's consent code: the unsigned pc1. consent request, carrying the whole plan and its
 * phrase to re-check. `proposal` is the plan hash; `hash` is the consent hash, which binds the
 * phrase.
 */
export async function jobConsentCode(o: {
  server: string;
  principal: string;
  input: unknown;
  hp: HashedPlan;
  phrase: string;
  now: number;
  ttl?: number;
}): Promise<string> {
  const detail = {
    job: planPreimage(o.input, o.hp),
    phrase: checkedPhrase(o.phrase),
  };
  const consent: ConsentRequest = {
    proposal: o.hp.planHash,
    hash: await consentHashOf(o.hp.planHash, detail.phrase),
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
 * must be typeable, the plan hash and the consent hash are recomputed from the plan and the
 * phrase, the tool must be the plan's, and it must not have expired. The expiry is capped at
 * `CONSENT_TTL` from now, whatever the code asks for.
 */
export async function readJobConsent(
  code: string,
  now: number,
): Promise<JobConsent> {
  const c = decodeConsentCode(code);
  const d = c.detail as unknown as
    | { job?: unknown; phrase?: unknown }
    | undefined;
  const job = d?.job;

  if (!isJob(job) || typeof d?.phrase !== 'string') {
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
    (await consentHashOf(planHash, phrase)) !== c.hash ||
    job.tool !== c.capability
  ) {
    throw new Error(
      "this consent code's plan or phrase doesn't match its hash",
    );
  }

  if (now >= c.expires) {
    throw new Error(
      'this consent code has expired; call the tool again for a fresh one',
    );
  }

  const { detail: _d, ...consent } = c;

  return {
    consent: { ...consent, expires: Math.min(c.expires, now + CONSENT_TTL) },
    job,
    phrase,
    planHash,
  };
}

/** The consent grant for a read job consent: signed by the principal, issued to the server. */
export const signJobConsent = (principal: KeyPair | string, j: JobConsent) =>
  consentGrant({ principal, agent: j.consent.service, consent: j.consent });
