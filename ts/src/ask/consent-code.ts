/**
 * Consent codes for `yea approve` (docs/framework/SPEC-approval.md §6): a job's
 * code when the client can't ask, and reading and signing one.
 */
import { type HashedPlan, planHashOf, planPreimage } from '../approval.js';
import {
  consentGrant,
  decodeConsentCode,
  encodeConsentCode,
} from '../consent.js';
import type { KeyPair } from '../crypto.js';
import { isRisk } from '../risk.js';
import type { ConsentRequest, Effect } from '../types.js';
import { isUses } from '../uses.js';
import { effectivePhrase } from './phrase.js';

/** A job consent code as `yea approve` may sign it: checked, with its expiry capped. */
export interface JobConsent {
  consent: ConsentRequest;
  job: Record<string, unknown> & {
    tool: string;
    summary: string;
    effects: Effect[];
  };
  phrase: string;
  planHash: string;
}

export const CONSENT_TTL = 600;

/** A job's consent code: the unsigned pc1. consent request, carrying the whole plan to re-check. */
export function jobConsentCode(o: {
  server: string;
  principal: string;
  input: unknown;
  hp: HashedPlan;
  phrase: string;
  now: number;
  ttl?: number;
}): string {
  const consent: ConsentRequest = {
    proposal: o.hp.planHash,
    hash: o.hp.planHash,
    service: o.server,
    capability: o.hp.tool,
    principal: o.principal,
    summary: o.hp.plan.summary,
    expires: o.now + (o.ttl ?? CONSENT_TTL),
  };
  const detail = {
    job: planPreimage(o.hp.tool, o.input, o.hp.plan, o.hp.risk),
    phrase: effectivePhrase(o.phrase),
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
 * Read a job consent code for signing (§6). Everything shown or signed is checked: the plan
 * hash is recomputed from the plan, the tool must be the plan's, and it must not have expired.
 * The expiry is capped at `CONSENT_TTL` from now, whatever the code asks for.
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

  const planHash = await planHashOf(job);

  if (
    planHash !== c.hash ||
    planHash !== c.proposal ||
    job.tool !== c.capability
  ) {
    throw new Error("this consent code's plan doesn't match its hash");
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
    phrase: effectivePhrase(d.phrase),
    planHash,
  };
}

/** The consent grant for a read job consent: signed by the principal, issued to the server. */
export const signJobConsent = (principal: KeyPair | string, j: JobConsent) =>
  consentGrant({ principal, agent: j.consent.service, consent: j.consent });
