/**
 * What every job shares: the Stripe client, whether the key is live, the clock, and the rules
 * that keep a plan's hash stable while a person decides (nothing finer than a day).
 */
import { PartialApplyError } from '@yea-protocol/mcp';
import type {
  Clarification,
  HashedPlan,
  JobPlan,
  Risk,
} from '@yea-protocol/sdk';
import { type StripeApi, StripeError } from './api.js';

export const DAY = 86_400;

export interface Ctx {
  stripe: StripeApi;
  /** Any key without `_test_` is live. */
  live: boolean;
  /** Now, in Unix seconds. */
  now(): number;
}

/** A job as this connector defines it, before it is registered with `approvals.job()`. */
export interface JobSpec<I> {
  name: string;
  title: string;
  description: string;
  /** The input's JSON Schema: a plain object. */
  schema: Record<string, unknown>;
  /** The tool's default risk in this mode; each plan sets its own. */
  risk: Risk;
  /** Reads only: GETs and `create_preview`. Every write is in a plan's `apply()`. */
  plan(input: I): Promise<JobPlan[] | Clarification>;
  /** Undo from what `apply()` returned, which the receipt stores. */
  revert?(input: I, result: unknown): Promise<unknown>;
}

/** The start of today, UTC: the one instant plans measure time from, so they stay the same all day. */
export const today = (ctx: Ctx) => Math.floor(ctx.now() / DAY) * DAY;

/** `2026-09-27`. */
export const day = (unix: number) =>
  new Date(unix * 1000).toISOString().slice(0, 10);

/** Every summary starts with the mode, so a person always knows which account they're in. */
export const tag = (ctx: Ctx) => (ctx.live ? '[LIVE]' : '[test]');

/** The risk table: live mode raises a plan's risk one level. */
export function riskFor(ctx: Ctx, base: 'low' | 'medium'): Risk {
  if (!ctx.live) {
    return base;
  }

  return base === 'low' ? 'medium' : 'high';
}

/**
 * A plan's `undoWindow`, ending at least a day before `end` (a renewal or period end), in whole
 * days from the start of today, so it's the same all day. None when less than that is left:
 * the plan is then treated as irreversible.
 */
export function undoWindowBefore(
  ctx: Ctx,
  end: number,
): { undoWindow?: number } {
  const days = Math.floor((end - today(ctx)) / DAY) - 1;

  return days > 0 ? { undoWindow: days * DAY } : {};
}

/** What a person types to approve a plan, carried in its `data`. */
export function confirmOf(hp: HashedPlan): string {
  const d = hp.plan.data;

  return typeof d === 'object' &&
    d !== null &&
    'confirm' in d &&
    typeof d.confirm === 'string'
    ? d.confirm
    : '';
}

/**
 * Run a write, and turn one whose result is unknown (no answer, or a 5xx) into a
 * `PartialApplyError`, so the result never says "nothing changed" when it might have.
 */
export async function applying<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (e) {
    if (e instanceof StripeError && e.unknown) {
      throw new PartialApplyError(e.message);
    }

    throw e;
  }
}
