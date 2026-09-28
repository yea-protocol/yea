/** Job plans and their hashes (SPEC-approval §1): the preimage, its integer check, and each plan's risk. */
import { canonical } from '../canonical.js';
import { sha256 } from '../crypto.js';
import { knownRisk, resolveRisk } from '../risk.js';
import type { Effect, Risk } from '../types.js';
import { isUses, type Uses } from '../uses.js';

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

  knownRisk(risk);

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
      const risk = resolveRisk('medium', plan.risk, tool.risk);

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
