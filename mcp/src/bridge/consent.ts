/**
 * Consents the person signed with `yea approve` (SPEC.md §6.6), as the bridge checks and keeps
 * them (SPEC-bridge, `yea_consent`), and the consent codes it hands out for them. The bridge
 * signs nothing: it only accepts a consent that commits one pending proposal, for this agent,
 * from the principal the call's grants name.
 */
import {
  checkGrant,
  consentCode,
  decodeGrant,
  type Proposal,
} from '@yea-protocol/sdk';
import { loadConsent, saveGrant } from '@yea-protocol/sdk/node';
import { errorMessage, isObject, type Obj } from '../util.js';
import type { Pending } from './pending.js';
import type { JobCall } from './types.js';

/** Where consents are kept, by the proposal hash they commit. */
export interface ConsentStore {
  get(hash: string): string | null;
  put(hash: string, token: string): void;
}

/** The agent's `~/.yea/consents`, which `yea approve` on this machine also writes. */
export const homeConsents: ConsentStore = {
  get: (hash) => loadConsent(hash),
  put: (hash, token) => saveGrant(token, 'consents', hash),
};

/** What a well-formed consent grant says. */
export interface ConsentFields {
  iss: string;
  sub: string;
  svc: string;
  can: string;
  only: string;
  exp: number;
}

const oneString = (v: unknown): v is [string] =>
  Array.isArray(v) && v.length === 1 && typeof v[0] === 'string';

const NOT_CONSENT =
  'not a consent grant: its caveats must be exactly svc, verbs [COMMIT], can, only and exp (SPEC.md §6.6)';

/** The five caveats as one object, or null unless each appears exactly once, well formed. */
function consentCaveats(
  caveats: unknown[],
): Omit<ConsentFields, 'iss' | 'sub'> | null {
  const seen: Obj = {};

  for (const c of caveats) {
    const keys = isObject(c) ? Object.keys(c) : [];

    if (keys.length !== 1 || Object.hasOwn(seen, keys[0])) {
      return null;
    }

    seen[keys[0]] = (c as Obj)[keys[0]];
  }

  const { svc, verbs, can, only, exp } = seen;
  const ok =
    Object.keys(seen).length === 5 &&
    oneString(svc) &&
    oneString(verbs) &&
    verbs[0] === 'COMMIT' &&
    oneString(can) &&
    typeof only === 'string' &&
    Number.isSafeInteger(exp);

  return ok
    ? { svc: svc[0], can: can[0], only: only as string, exp: exp as number }
    : null;
}

/** A `pg1.` grant of a single root block with exactly §6.6's caveats; or why it isn't one. */
export function readConsent(token: unknown): ConsentFields | { why: string } {
  if (typeof token !== 'string' || !token.startsWith('pg1.')) {
    return { why: 'not a pg1. grant' };
  }

  let blocks: ReturnType<typeof decodeGrant>;

  try {
    blocks = decodeGrant(token);
  } catch (e) {
    return { why: `not a readable grant (${errorMessage(e)})` };
  }

  if (blocks.length !== 1) {
    return { why: 'a delegated grant is not a consent' };
  }

  const { iss, sub, caveats } = blocks[0].p;
  const fields = consentCaveats(caveats);

  if (typeof iss !== 'string' || !fields) {
    return { why: NOT_CONSENT };
  }

  return { iss, sub, ...fields };
}

/** The pending proposal a consent's `svc`, `can` and `only` name, if `entry` has it. */
const proposalFor = (entry: Pending, f: ConsentFields) =>
  f.svc === entry.service && f.can === entry.capability
    ? entry.proposals.find((p) => p.hash === f.only)
    : undefined;

/** Why a well-formed consent can't commit `p` in `entry` for `agent` now; null if it can. */
function mismatch(
  f: ConsentFields,
  o: { entry: Pending; agent: string; now: number },
): string | null {
  if (!o.entry.principal || f.iss !== o.entry.principal) {
    return "it isn't signed by the principal whose grants this agent uses here";
  }

  if (f.sub !== o.agent) {
    return "it's issued to another key, not this agent's";
  }

  return f.exp > o.now ? null : 'it has expired';
}

export type ConsentCheck =
  | { ok: true; proposal: Proposal; fields: ConsentFields }
  | { ok: false; why: string };

/**
 * Check a consent against one pending entry (SPEC-bridge `yea_consent`): its shape, principal,
 * holder, proposal and expiry, then its signature, through the same grant check a service runs.
 */
export async function checkConsent(
  token: unknown,
  o: { entry: Pending; agent: string; now: number },
): Promise<ConsentCheck> {
  const f = readConsent(token);

  if ('why' in f) {
    return { ok: false, why: f.why };
  }

  const p = proposalFor(o.entry, f);

  if (!p) {
    return { ok: false, why: 'it is for no pending proposal of this call' };
  }

  const why = mismatch(f, o);

  if (why) {
    return { ok: false, why };
  }

  const r = await checkGrant(token as string, {
    service: f.svc,
    verb: 'COMMIT',
    capability: f.can,
    now: o.now,
    proposal: { hash: p.hash, uses: p.uses, risk: p.risk },
    trusted: [f.iss],
    proofKey: o.agent,
  });

  return r.ok
    ? { ok: true, proposal: p, fields: f }
    : { ok: false, why: `its check failed: ${r.reason}` };
}

/** A consent code per kept proposal: `yea approve` elsewhere signs to `agent`. */
export function codesFor(call: JobCall, entry: Pending) {
  const principal = entry.principal;
  const agent = call.svc.agent;

  if (!principal || !agent) {
    return [];
  }

  return entry.proposals.map((p) => ({
    proposal: p.id,
    code: consentCode(
      {
        proposal: p.id,
        hash: p.hash,
        service: entry.service,
        capability: p.capability,
        principal,
        summary: p.summary,
        expires: p.expires,
      },
      p,
      { agent },
    ),
  }));
}
