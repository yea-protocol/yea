/** The policy decision (SPEC-approval §2, §5): whether a job call runs, asks, or is refused. */
import { checkGrant } from '../grants.js';
import { atLeast } from '../risk.js';
import type { LedgerKey } from '../store.js';
import type { Risk } from '../types.js';
import { isLimit } from '../uses.js';
import { blocksOf, caveatOf } from './grant-blocks.js';
import type { HashedPlan } from './plans.js';
import { type ReserveFor, reservationsFor } from './reservations.js';

/** The person's standing rules (SPEC-approval §2). */
export interface Policy {
  /** The signed policy grant (pg1.), issued to the server's key; null means nothing auto-runs. */
  grant: string | null;
  /** The pinned principal public key the grant must be signed by. */
  principal: string;
  /** The server's public key: its service id and the grant's holder. */
  server: string;
  deny: string[];
  outOfBand: Risk;
}

export type Decision =
  | { kind: 'nothing' }
  | RuledOut
  | { kind: 'ask'; why: string }
  | { kind: 'run'; plan: HashedPlan; reserve: ReserveFor[] };

/** A plan the unsigned rules keep from running here, and why. */
export type RuledOut =
  | { kind: 'denied'; why: string }
  | { kind: 'out-of-band'; why: string };

/** Why the person's policy never allows `tool`, or null when it doesn't deny it. */
export const deniedWhy = (tool: string, policy: Pick<Policy, 'deny'>) =>
  policy.deny.includes(tool) ? `your policy never allows ${tool}` : null;

/** Why a plan at or above `outOfBand` can only be approved outside the chat. */
export const outOfBandWhy = (hp: HashedPlan) =>
  `risk is ${hp.risk}, which needs approval outside the chat`;

/**
 * The one check of a plan against the unsigned rules (SPEC-approval §2): denied, or at or above
 * `outOfBand` and so approved only outside the chat; null when neither.
 */
export function ruledOut(
  hp: HashedPlan,
  policy: Pick<Policy, 'deny' | 'outOfBand'>,
): RuledOut | null {
  const denied = deniedWhy(hp.tool, policy);

  if (denied) {
    return { kind: 'denied', why: denied };
  }

  return atLeast(hp.risk, policy.outOfBand)
    ? { kind: 'out-of-band', why: outOfBandWhy(hp) }
    : null;
}

/**
 * What a job call should do with these plans under this policy (SPEC-approval §2, §5).
 * Only `plans[0]` is ever run without asking.
 */
export async function decide(
  plans: HashedPlan[],
  policy: Policy,
  used: (k: LedgerKey) => bigint | Promise<bigint>,
  now?: number,
): Promise<Decision> {
  const first = plans[0];

  if (!first) {
    return { kind: 'nothing' };
  }

  const out = ruledOut(first, policy);

  if (out) {
    return out;
  }

  if (!first.undoable) {
    return { kind: 'ask', why: `${first.tool} can't be undone` };
  }

  return allowedToRun(first, policy, used, now);
}

/** What the grant's `total` limits have used so far, read ahead so the check stays synchronous. */
async function usedByTotals(
  blocks: { id: string; caveats: unknown[] }[],
  used: (k: LedgerKey) => bigint | Promise<bigint>,
): Promise<Map<string, bigint>> {
  const out = new Map<string, bigint>();

  for (const b of blocks) {
    for (const c of b.caveats) {
      const l = caveatOf(c, 'total');

      if (isLimit(l)) {
        out.set(`${b.id} ${l.of}`, await used({ block: b.id, of: l.of }));
      }
    }
  }

  return out;
}

/** Whether the signed policy grant lets this plan run as a COMMIT at this server. */
async function allowedToRun(
  hp: HashedPlan,
  policy: Policy,
  used: (k: LedgerKey) => bigint | Promise<bigint>,
  now?: number,
): Promise<Decision> {
  if (!policy.grant) {
    return {
      kind: 'ask',
      why: `no signed policy lets ${hp.tool} run without asking`,
    };
  }

  const blocks = await blocksOf(policy.grant);

  // A policy must name the tools it lets run; a grant without `can` covers every tool.
  if (
    blocks &&
    !blocks.some((b) => b.caveats.some((c) => caveatOf(c, 'can') !== undefined))
  ) {
    return {
      kind: 'ask',
      why: `the signed policy names no tools, so it doesn't let ${hp.tool} run without asking`,
    };
  }

  const sofar = blocks
    ? await usedByTotals(blocks, used)
    : new Map<string, bigint>();
  const check = await checkGrant(policy.grant, {
    service: policy.server,
    verb: 'COMMIT',
    capability: hp.tool,
    ...(now === undefined ? {} : { now }),
    proposal: { hash: hp.planHash, uses: hp.plan.uses, risk: hp.risk },
    trusted: [policy.principal],
    proofKey: policy.server,
    used: (block, of) => sofar.get(`${block} ${of}`) ?? 0n,
  });

  if (!check.ok) {
    return { kind: 'ask', why: check.reason };
  }

  return { kind: 'run', plan: hp, reserve: reservationsFor(hp, check.totals) };
}
