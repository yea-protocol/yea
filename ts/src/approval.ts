/**
 * The approval core for job tools (docs/framework/SPEC-approval.md): plan hashes, the policy
 * decision, reservations against `total` limits, and undo. What a person is asked and how
 * their answer is judged is in ask.ts. Store-agnostic and dependency-free.
 */
import { canonical } from './canonical.js';
import { randomId, sha256 } from './crypto.js';
import {
  blockId,
  checkGrant,
  decodeGrant,
  type TotalLimit,
  usedOf,
} from './grants.js';
import { atLeast, isRisk } from './risk.js';
import type {
  ApprovalStore,
  JobReceipt,
  LedgerKey,
  Reservation,
} from './store.js';
import type { Effect, Risk } from './types.js';
import { exact, isLimit, isUses, type Uses } from './uses.js';
import { isObject } from './util.js';

/** What a job tool's handler returns for each way it could do the job (SPEC-approval §1). */
export interface JobPlan {
  summary: string;
  effects: Effect[];
  uses?: Uses;
  risk?: Risk;
  /** Seconds the job can be undone for; needs the tool's `revert` too. */
  undoWindow?: number;
  data?: unknown;
  /** Do the job. Only called once the plan is allowed or approved. */
  apply(): unknown;
}

/** A plan with what the approval core needs to judge it. */
export interface HashedPlan {
  tool: string;
  plan: JobPlan;
  planHash: string;
  risk: Risk;
  undoable: boolean;
}

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
  | { kind: 'denied'; why: string }
  | { kind: 'out-of-band'; why: string }
  | { kind: 'ask'; why: string }
  | { kind: 'run'; plan: HashedPlan; reserve: ReserveFor[] };

/** One reservation an auto-run needs: the ledger entry, how much, and the smallest `max`. */
export interface ReserveFor {
  key: LedgerKey;
  amount: bigint;
  max: bigint;
}

/** The unsigned part of a policy: it can only tighten (SPEC-approval §2). */
export interface Tightening {
  deny: string[];
  outOfBand: Risk;
  /** What was ignored, for stderr. */
  warnings: string[];
}

/**
 * Read `~/.yea/policy.json` or server options. Unknown fields and bad values are ignored with
 * a warning, and the valid tightenings still apply; nothing here can make more run.
 */
export function readTightening(v: unknown): Tightening {
  const out: Tightening = { deny: [], outOfBand: 'high', warnings: [] };

  if (!isObject(v)) {
    out.warnings.push('the policy file is not a JSON object; ignored');

    return out;
  }

  for (const [k, x] of Object.entries(v)) {
    if (
      k === 'deny' &&
      Array.isArray(x) &&
      x.every((t) => typeof t === 'string')
    ) {
      out.deny = x;
    } else if (k === 'outOfBand' && isRisk(x)) {
      out.outOfBand = x;
    } else {
      out.warnings.push(
        `ignored ${JSON.stringify(k)}: ${k === 'deny' || k === 'outOfBand' ? 'bad value' : 'unknown field'}`,
      );
    }
  }

  return out;
}

/**
 * Job inputs are hashed, and canonical JSON allows only integers (SPEC.md §10). Throws a
 * TypeError naming the first non-integer number, so a plugin can refuse the call before planning.
 */
export function assertIntegers(v: unknown, path = 'input'): void {
  if (typeof v === 'number' && !Number.isSafeInteger(v)) {
    throw new TypeError(
      `${path} is ${v}: job inputs can only hold safe integers; use a string for other numbers`,
    );
  }

  if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      assertIntegers(x, `${path}.${k}`);
    }
  }
}

/** The fields a plan hash covers, in the form `yea approve` recomputes it from. */
export function planPreimage(
  tool: string,
  input: unknown,
  plan: Pick<JobPlan, 'summary' | 'effects' | 'uses' | 'undoWindow'>,
  risk: Risk,
): Record<string, unknown> {
  assertIntegers(input);

  if (plan.uses !== undefined && !isUses(plan.uses)) {
    throw new TypeError(
      `plan has a malformed uses: ${JSON.stringify(plan.uses)}`,
    );
  }

  return {
    tool,
    input,
    summary: plan.summary,
    effects: plan.effects,
    // Absent and empty mean the same (SPEC.md §5.1), so they hash the same.
    ...(plan.uses && Object.keys(plan.uses).length ? { uses: plan.uses } : {}),
    risk,
    ...(plan.undoWindow === undefined ? {} : { undoWindow: plan.undoWindow }),
  };
}

/** SPEC-approval §1: stable when the same plan is recomputed, unlike a proposal hash. */
export const planHashOf = (preimage: Record<string, unknown>) =>
  sha256(canonical(preimage));

/** Hash each plan and resolve its risk (plan, else the tool's, else `medium`). */
export function hashPlans(
  tool: { name: string; risk?: Risk; revert?: unknown },
  input: unknown,
  plans: JobPlan[],
): Promise<HashedPlan[]> {
  return Promise.all(
    plans.map(async (plan) => {
      const risk = plan.risk ?? tool.risk ?? 'medium';

      return {
        tool: tool.name,
        plan,
        planHash: await planHashOf(planPreimage(tool.name, input, plan, risk)),
        risk,
        undoable: plan.undoWindow !== undefined && tool.revert !== undefined,
      };
    }),
  );
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

  if (policy.deny.includes(first.tool)) {
    return { kind: 'denied', why: `your policy never allows ${first.tool}` };
  }

  if (atLeast(first.risk, policy.outOfBand)) {
    return {
      kind: 'out-of-band',
      why: `risk is ${first.risk}, which needs approval outside the chat`,
    };
  }

  if (!first.undoable) {
    return { kind: 'ask', why: `${first.tool} can't be undone` };
  }

  return allowedToRun(first, policy, used, now);
}

/** A grant's blocks with their ids, or null if it can't be decoded (the grant check says why). */
async function blocksOf(
  grant: string,
): Promise<{ id: string; caveats: unknown[] }[] | null> {
  try {
    return await Promise.all(
      decodeGrant(grant).map(async (b) => ({
        id: await blockId(b),
        caveats: b.p.caveats,
      })),
    );
  } catch {
    return null;
  }
}

const caveatOf = (c: unknown, k: string): unknown =>
  c && typeof c === 'object' && Object.hasOwn(c, k)
    ? (c as Record<string, unknown>)[k]
    : undefined;

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

/** One reservation per block and measure the plan uses; a repeated `total` keeps its smallest `max`. */
function reservationsFor(hp: HashedPlan, totals: TotalLimit[]): ReserveFor[] {
  const out = new Map<string, ReserveFor>();

  for (const t of totals) {
    const q = usedOf(hp.plan.uses, t.of);
    const id = `${t.id} ${t.of}`;
    const seen = out.get(id);

    if (!q) {
      continue;
    }

    if (!seen || t.max < seen.max) {
      out.set(id, {
        key: { block: t.id, of: t.of },
        amount: exact(q),
        max: t.max,
      });
    }
  }

  return [...out.values()];
}

/**
 * Reserve everything an auto-run needs, all or nothing (SPEC-approval §5). Null means one
 * would pass its limit: the ones already made are released and the call should ask instead.
 */
export async function reserveAll(
  store: ApprovalStore,
  wanted: ReserveFor[],
): Promise<Reservation[] | null> {
  const made: Reservation[] = [];
  const undo = () => Promise.all(made.map((m) => store.release(m)));

  try {
    for (const w of wanted) {
      const r = await store.reserve(w.key, w.amount, w.max);

      if (!r) {
        await undo();

        return null;
      }

      made.push(r);
    }
  } catch (e) {
    await undo();

    throw e;
  }

  return made;
}

/**
 * Whether a stored consent may run this plan (SPEC-approval §6): it must be a consent grant for
 * exactly this plan (`only` and `exp` present), signed by the pinned principal and issued to
 * the server. A copied policy grant fails the `only` test. `id` is what to consume it by.
 */
export async function checkJobConsent(
  grant: string,
  o: {
    hp: HashedPlan;
    policy: Pick<Policy, 'principal' | 'server'>;
    now?: number;
  },
): Promise<{ ok: true; id: string } | { ok: false; why: string }> {
  const blocks = await blocksOf(grant);
  // A consent comes straight from the principal: one root block that itself carries `only`
  // and `exp`. A delegated block can't turn another grant (the policy) into a consent.
  const root = blocks?.length === 1 ? blocks[0] : null;
  const has = (k: string, want?: unknown) =>
    !!root?.caveats.some((c) => {
      const v = caveatOf(c, k);

      return v !== undefined && (want === undefined || v === want);
    });

  if (!root || !has('only', o.hp.planHash) || !has('exp')) {
    return { ok: false, why: 'not a consent for this plan' };
  }

  const check = await checkGrant(grant, {
    service: o.policy.server,
    verb: 'COMMIT',
    capability: o.hp.tool,
    ...(o.now === undefined ? {} : { now: o.now }),
    proposal: { hash: o.hp.planHash, uses: o.hp.plan.uses, risk: o.hp.risk },
    trusted: [o.policy.principal],
    proofKey: o.policy.server,
  });

  return check.ok
    ? { ok: true, id: check.id }
    : { ok: false, why: check.reason };
}

/** Receipt ids are `r_` and 8 to 32 b64url characters; anything else never reaches the store. */
export const isReceiptId = (id: unknown): id is string =>
  typeof id === 'string' && /^r_[A-Za-z0-9_-]{8,32}$/.test(id);

export const newReceiptId = () => randomId('r');

export type UndoOutcome =
  | { kind: 'undone'; receipt: JobReceipt }
  | { kind: 'refused'; why: string };

/**
 * Undo a job (SPEC-approval §7): within its window, for the same principal, once. The tool's
 * `revert` gets what the receipt stored, so any process can undo it.
 */
export async function undoJob(
  store: ApprovalStore,
  opts: {
    id: unknown;
    /** This server's service id: a receipt from another server sharing the store is unknown. */
    service: string;
    sub: string;
    now: number;
    revert: (r: JobReceipt) => unknown;
  },
): Promise<UndoOutcome> {
  const found = isReceiptId(opts.id) ? await store.getReceipt(opts.id) : null;
  const r = found?.service === opts.service ? found : null;
  const why = undoRefusal(r, opts.sub, opts.now);

  if (why || !r) {
    return { kind: 'refused', why: why ?? 'no such receipt' };
  }

  if (!(await store.claimUndo(r.id))) {
    return { kind: 'refused', why: 'this job was already undone' };
  }

  try {
    await opts.revert(r);
  } catch (e) {
    await store.releaseUndo(r.id);

    throw e;
  }

  await store.markUndone(r.id);

  return { kind: 'undone', receipt: r };
}

function undoRefusal(
  r: JobReceipt | null,
  sub: string,
  now: number,
): string | null {
  if (!r || r.sub !== sub) {
    return 'no such receipt';
  }

  if (!r.undo) {
    return 'this job can never be undone';
  }

  // Open through `until` itself, as in the protocol's UNDO (SPEC.md §4.5).
  return now > r.undo.until ? 'the undo window has closed' : null;
}
