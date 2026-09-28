/**
 * Asking a person to approve a job (docs/framework/SPEC-approval.md §3–§6): the confirmation
 * phrase, the form, the state that goes round the client, how the answer is judged, and the
 * consent code for `yea approve` when the client can't ask.
 */
import {
  type HashedPlan,
  type Policy,
  planHashOf,
  planPreimage,
} from './approval.js';
import { canonical } from './canonical.js';
import { type KeyPair, randomId, sha256 } from './crypto.js';
import {
  consentGrant,
  decodeConsentCode,
  encodeConsentCode,
} from './grants.js';
import { effectLine, fmtDuration } from './lens.js';
import { atLeast, isRisk } from './risk.js';
import type { ConsentRequest, Effect } from './types.js';
import { fmtUses, isUses } from './uses.js';
import { isStringList } from './util.js';

// ---- the confirmation phrase (§3) ----

/** Exactly these are stripped from both ends; not trim()/strip(), which disagree. */
const EDGE = /^[\t\n\v\f\r \u00a0\ufeff]+|[\t\n\v\f\r \u00a0\ufeff]+$/g;

const normalizePhrase = (s: string) =>
  s.normalize('NFC').replace(EDGE, '').toLowerCase();

/** An empty phrase never matches, so an empty or auto-filled answer can't approve. */
export const phraseMatches = (typed: unknown, phrase: string) =>
  typeof typed === 'string' &&
  normalizePhrase(phrase) !== '' &&
  normalizePhrase(typed) === normalizePhrase(phrase);

/** The phrase a person types to approve this plan: the tool's, or `approve`. */
export type PhraseFor = (hp: HashedPlan) => string;

export const DEFAULT_PHRASE = 'approve';

/** A phrase that is empty once normalized falls back to `approve`. */
const effectivePhrase = (phrase: string) =>
  normalizePhrase(phrase) === '' ? DEFAULT_PHRASE : phrase;

const withFallback =
  (phraseFor: PhraseFor): PhraseFor =>
  (hp) =>
    effectivePhrase(phraseFor(hp));

// ---- the form (§3) ----

export interface ApprovalForm {
  message: string;
  requestedSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
  /** The plan hashes the form offers; the state carries these. */
  offered: string[];
}

/** One plan as the person reads it: summary, effects, then what it uses, risk and undo. */
function planText(n: number, hp: HashedPlan, phrase: string | null): string[] {
  const p = hp.plan;
  const attrs = [
    ...(p.uses && Object.keys(p.uses).length
      ? [`uses: ${fmtUses(p.uses)}`]
      : []),
    `risk: ${hp.risk}`,
    `undo: ${hp.undoable && p.undoWindow ? fmtDuration(p.undoWindow) : 'never'}`,
  ];

  return [
    `[${n}] ${p.summary}`,
    ...p.effects.map((e) => `  ${effectLine(e)}`),
    `  ${attrs.join(' · ')}`,
    ...(phrase === null ? [] : [`  to approve, type: ${phrase}`]),
  ];
}

/** `[n], [m]` for the listed plans, numbered as in the message. */
const numbers = (plans: HashedPlan[], some: HashedPlan[]) =>
  some.map((hp) => `[${plans.indexOf(hp) + 1}]`).join(', ');

/**
 * The form-mode elicitation for these plans (§3). Denied plans and plans at or above
 * `outOfBand` are listed but not offered. Null when nothing can be offered: the caller then
 * fails closed with consent codes (§6).
 */
export function buildForm(
  plans: HashedPlan[],
  why: string,
  policy: Pick<Policy, 'outOfBand' | 'deny'>,
  phraseFor: PhraseFor,
): ApprovalForm | null {
  const phrase = withFallback(phraseFor);
  const denied = plans.filter((hp) => policy.deny.includes(hp.tool));
  const outside = plans.filter(
    (hp) => !denied.includes(hp) && atLeast(hp.risk, policy.outOfBand),
  );
  const offered = plans.filter(
    (hp) => !denied.includes(hp) && !outside.includes(hp),
  );

  if (!offered.length) {
    return null;
  }

  const message = [
    `Approval needed: ${why}.`,
    '',
    ...plans.flatMap((hp, i) =>
      planText(i + 1, hp, offered.includes(hp) ? phrase(hp) : null),
    ),
    ...(outside.length
      ? [
          '',
          `Not offered here (approve outside the chat): ${numbers(plans, outside)}`,
        ]
      : []),
    ...(denied.length
      ? ['', `Never allowed by your policy: ${numbers(plans, denied)}`]
      : []),
  ].join('\n');

  return {
    message,
    requestedSchema: formSchema(offered, phrase),
    offered: offered.map((hp) => hp.planHash),
  };
}

function formSchema(
  offered: HashedPlan[],
  phraseFor: PhraseFor,
): ApprovalForm['requestedSchema'] {
  const confirm = {
    type: 'string',
    title: 'Confirm',
    description:
      offered.length === 1
        ? `Type "${phraseFor(offered[0])}" to approve.`
        : "Type the chosen plan's phrase, shown next to it above.",
  };

  if (offered.length === 1) {
    return {
      type: 'object',
      properties: { confirm },
      required: ['confirm'],
    };
  }

  return {
    type: 'object',
    properties: {
      plan: {
        type: 'string',
        title: 'Plan',
        oneOf: offered.map((hp) => ({
          const: hp.planHash,
          title: hp.plan.summary,
        })),
      },
      confirm,
    },
    required: ['plan', 'confirm'],
  };
}

// ---- the state that goes round the client (§4) ----

export interface ApprovalState {
  v: 1;
  tool: string;
  inputHash: string;
  sub: string;
  plans: string[];
  round: number;
  nonce: string;
  exp: number;
}

export const MAX_ROUNDS = 3;
export const STATE_TTL = 600;

export const inputHashOf = (input: unknown) => sha256(canonical(input));

export function newState(o: {
  tool: string;
  inputHash: string;
  sub: string;
  plans: string[];
  round: number;
  now: number;
  ttl?: number;
}): ApprovalState {
  return {
    v: 1,
    tool: o.tool,
    inputHash: o.inputHash,
    sub: o.sub,
    plans: o.plans,
    round: o.round,
    nonce: randomId('n', 12),
    exp: o.now + (o.ttl ?? STATE_TTL),
  };
}

function isState(v: unknown): v is ApprovalState {
  const s = v as Partial<ApprovalState> | null;

  return (
    !!s &&
    s.v === 1 &&
    typeof s.tool === 'string' &&
    typeof s.inputHash === 'string' &&
    typeof s.sub === 'string' &&
    isStringList(s.plans) &&
    Number.isSafeInteger(s.round) &&
    typeof s.nonce === 'string' &&
    Number.isSafeInteger(s.exp)
  );
}

/** Why a returned state can't be used for this call; one message for every reason (§5 step 1). */
export function checkState(
  v: unknown,
  expect: { tool: string; inputHash: string; sub: string; now: number },
): ApprovalState | null {
  if (
    !isState(v) ||
    v.tool !== expect.tool ||
    v.inputHash !== expect.inputHash ||
    v.sub !== expect.sub ||
    expect.now >= v.exp
  ) {
    return null;
  }

  return v;
}

// ---- judging the answer (§5 steps 3–7; the caller has checked the state and consumed its nonce) ----

export interface ApprovalAnswer {
  action: 'accept' | 'decline' | 'cancel';
  content?: { plan?: unknown; confirm?: unknown };
}

export type Verdict =
  | { kind: 'refuse'; why: string }
  | { kind: 'not-approved' }
  | { kind: 'ask-again'; why: string; round: number }
  | { kind: 'denied'; why: string }
  | { kind: 'out-of-band'; plan: HashedPlan }
  | { kind: 'run'; plan: HashedPlan };

/** Ask again, unless that would pass the last round. */
function again(state: ApprovalState, why: string): Verdict {
  const round = state.round + 1;

  return round > MAX_ROUNDS
    ? { kind: 'refuse', why: `not approved after ${MAX_ROUNDS} tries` }
    : { kind: 'ask-again', why, round };
}

function chosenHash(state: ApprovalState, a: ApprovalAnswer): string | null {
  const plan = a.content?.plan;

  if (typeof plan === 'string') {
    return state.plans.includes(plan) ? plan : null;
  }

  return state.plans.length === 1 ? state.plans[0] : null;
}

/** What the plans, policy and phrases look like now, on the retry. */
export interface JudgeContext {
  recomputed: HashedPlan[];
  policy: Pick<Policy, 'outOfBand' | 'deny'>;
  phraseFor: PhraseFor;
}

export function judgeAnswer(
  state: ApprovalState,
  answer: ApprovalAnswer,
  { recomputed, policy, phraseFor }: JudgeContext,
): Verdict {
  const phrase = withFallback(phraseFor);

  if (answer.action !== 'accept') {
    return { kind: 'not-approved' };
  }

  const hash = chosenHash(state, answer);

  if (!hash) {
    return { kind: 'refuse', why: 'that plan was not offered' };
  }

  const hp = recomputed.find((p) => p.planHash === hash);

  if (!hp) {
    return again(state, 'the plans changed; choose again');
  }

  if (policy.deny.includes(hp.tool)) {
    return { kind: 'denied', why: `your policy never allows ${hp.tool}` };
  }

  if (atLeast(hp.risk, policy.outOfBand)) {
    return { kind: 'out-of-band', plan: hp };
  }

  return phraseMatches(answer.content?.confirm, phrase(hp))
    ? { kind: 'run', plan: hp }
    : again(state, `type "${phrase(hp)}" exactly to approve`);
}

// ---- consent codes for `yea approve` (§6) ----

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
