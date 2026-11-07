/**
 * Job plans and their hashes (SPEC-approval §1): the preimage, its integer check, each plan's
 * risk, and whether it can be undone.
 */
import { canonical } from '../canonical.js';
import { sha256 } from '../crypto.js';
import { MAX_APPROVAL_DEPTH, tooDeepToApprove } from '../lens.js';
import { knownRisk, resolveRisk } from '../risk.js';
import type { Effect, Risk } from '../types.js';
import { isUndoWindow } from '../undo-window.js';
import { isUses, type Uses } from '../uses.js';

/** What a job tool's handler returns for each way it could do the job (SPEC-approval §1). */
export interface JobPlan {
  summary: string;
  effects: Effect[];
  uses?: Uses;
  risk?: Risk;
  /**
   * Seconds the job can be undone for: a positive integer, and the tool needs `revert` too.
   * Anything else, zero included, leaves the plan not undoable.
   */
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
 * A plan as a person is shown it and its hash binds it: the plan-hash preimage without `tool`
 * and `input` (SPEC-approval §1). `undoWindow` is there only when the plan is undoable, so
 * hashing, the form, the MCP results and `yea approve` all read undo from this one field.
 */
export interface ShownPlan {
  summary: string;
  effects: Effect[];
  uses?: Uses;
  risk: Risk;
  undoWindow?: number;
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

/**
 * True when the part of a plan a person reads (summary, effects, uses) nests too deep to show in
 * full, so it can't be approved (SPEC.md §6.6): nothing approved may be cut from view.
 */
export const planTooDeep = ({
  summary,
  effects,
  uses,
}: Pick<JobPlan, 'summary' | 'effects' | 'uses'>) =>
  tooDeepToApprove({ summary, effects, uses });

/**
 * What a plan's preimage is built from: the plan, its tool, its resolved risk and whether it can
 * be undone. A {@link HashedPlan} is one.
 */
export interface JudgedPlan {
  tool: string;
  plan: Pick<JobPlan, 'summary' | 'effects' | 'uses' | 'undoWindow'>;
  risk: Risk;
  undoable: boolean;
}

/** The plan as a person is shown it (see {@link ShownPlan}), absent fields left out. */
export function shownPlan({
  plan,
  risk,
  undoable,
}: Omit<JudgedPlan, 'tool'>): ShownPlan {
  return {
    summary: plan.summary,
    effects: plan.effects,
    // Absent and empty mean the same (SPEC.md §5.1), so they hash the same.
    ...(plan.uses && Object.keys(plan.uses).length ? { uses: plan.uses } : {}),
    risk,
    // Checked again so a hand-built HashedPlan can't put a window that isn't one in view.
    ...(undoable && isUndoWindow(plan.undoWindow)
      ? { undoWindow: plan.undoWindow }
      : {}),
  };
}

/** The fields a plan hash covers, in the form `yea approve` recomputes it from. */
export function planPreimage(
  input: unknown,
  judged: JudgedPlan,
): Record<string, unknown> {
  const { plan } = judged;

  assertIntegers(input);

  if (plan.uses !== undefined && !isUses(plan.uses)) {
    throw new TypeError(
      `plan has a malformed uses: ${JSON.stringify(plan.uses)}`,
    );
  }

  knownRisk(judged.risk);

  if (planTooDeep(plan)) {
    throw new TypeError(
      `plan is nested past ${MAX_APPROVAL_DEPTH} levels, too deep to show in full`,
    );
  }

  return { tool: judged.tool, input, ...shownPlan(judged) };
}

/** SPEC-approval §1: stable when the same plan is recomputed, unlike a proposal hash. */
export const planHashOf = (preimage: Record<string, unknown>) =>
  sha256(canonical(preimage));

/**
 * Hash each plan and resolve its risk (plan, else the tool's, else `medium`). A plan is undoable
 * if and only if its `undoWindow` is a positive integer and the tool has `revert` (§1, §7).
 */
export function hashPlans(
  tool: { name: string; risk?: Risk; revert?: unknown },
  input: unknown,
  plans: JobPlan[],
): Promise<HashedPlan[]> {
  return Promise.all(
    plans.map(async (plan) => {
      const judged = {
        tool: tool.name,
        plan,
        risk: resolveRisk('medium', plan.risk, tool.risk),
        undoable: isUndoWindow(plan.undoWindow) && tool.revert !== undefined,
      };

      return {
        ...judged,
        planHash: await planHashOf(planPreimage(input, judged)),
      };
    }),
  );
}
