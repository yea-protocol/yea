/**
 * The approval core for job tools (docs/framework/SPEC-approval.md): plan hashes, the policy
 * decision, reservations against `total` limits, and undo. What a person is asked and how
 * their answer is judged is in ask.ts. Store-agnostic and dependency-free.
 */
import { canonical } from './canonical.js';
import { randomId, sha256 } from './crypto.js';
import { checkGrant, type TotalLimit, usedOf } from './grants.js';
import type {
  ApprovalStore,
  JobReceipt,
  LedgerKey,
  Reservation,
} from './store.js';
import type { Effect, Risk } from './types.js';
import { exact, type Uses } from './uses.js';

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

const RISKS: Risk[] = ['low', 'medium', 'high'];

/** The unsigned part of a policy: it can only tighten (SPEC-approval §2). */
export interface Tightening {
  deny: string[];
  outOfBand: Risk;
  /** What was ignored, for stderr. */
  warnings: string[];
}

const isRisk = (v: unknown): v is Risk => RISKS.includes(v as Risk);

/**
 * Read `~/.yea/policy.json` or server options. Unknown fields and bad values are ignored with
 * a warning, and the valid tightenings still apply; nothing here can make more run.
 */
export function readTightening(v: unknown): Tightening {
  const out: Tightening = { deny: [], outOfBand: 'high', warnings: [] };

  if (!v || typeof v !== 'object' || Array.isArray(v)) {
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

export const atLeast = (r: Risk, floor: Risk) =>
  RISKS.indexOf(r) >= RISKS.indexOf(floor);

/** Job inputs are hashed, and canonical JSON allows only integers (SPEC.md §10). */
function assertIntegers(v: unknown, path = 'input'): void {
  if (typeof v === 'number' && !Number.isSafeInteger(v)) {
    throw new TypeError(
      `${path} is ${v}: job inputs can't hold non-integer numbers; use a string or an integer`,
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

  return {
    tool,
    input,
    summary: plan.summary,
    effects: plan.effects,
    ...(plan.uses === undefined ? {} : { uses: plan.uses }),
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
  used: (k: LedgerKey) => bigint,
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

/** Whether the signed policy grant lets this plan run as a COMMIT at this server. */
async function allowedToRun(
  hp: HashedPlan,
  policy: Policy,
  used: (k: LedgerKey) => bigint,
  now?: number,
): Promise<Decision> {
  if (!policy.grant) {
    return {
      kind: 'ask',
      why: `no signed policy lets ${hp.tool} run without asking`,
    };
  }

  const check = await checkGrant(policy.grant, {
    service: policy.server,
    verb: 'COMMIT',
    capability: hp.tool,
    ...(now === undefined ? {} : { now }),
    proposal: { hash: hp.planHash, uses: hp.plan.uses, risk: hp.risk },
    trusted: [policy.principal],
    proofKey: policy.server,
    used: (block, of) => used({ block, of }),
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

  for (const w of wanted) {
    const r = await store.reserve(w.key, w.amount, w.max);

    if (!r) {
      await Promise.all(made.map((m) => store.release(m)));

      return null;
    }

    made.push(r);
  }

  return made;
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
    sub: string;
    now: number;
    revert: (r: JobReceipt) => unknown;
  },
): Promise<UndoOutcome> {
  const r = isReceiptId(opts.id) ? await store.getReceipt(opts.id) : null;
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

  return now >= r.undo.until ? 'the undo window has closed' : null;
}
