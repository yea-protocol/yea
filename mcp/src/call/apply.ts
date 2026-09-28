/**
 * A job call after approval (SPEC-mcp-ts, "How a call runs", step 11): apply once, then settle
 * the reservations and record the receipt; and what to say when something fails after `apply()`.
 */
import {
  type CallToolResult,
  isInputRequiredResult,
} from '@modelcontextprotocol/server';
import {
  type HashedPlan,
  type JobReceipt,
  newReceiptId,
  type Reservation,
} from '@yea-protocol/sdk';
import { receiptResult } from '../render.js';
import { errorResult, textResult } from '../result.js';
import { errorMessage, isObject } from '../util.js';
import type { Call, JobDef, Result, Yea } from './context.js';

/**
 * A guarded tool's own error, or a request for input, is a failed apply. This inspects the value
 * the original callback actually returned (a plain object, often a literal), structurally: no
 * class is assumed, and `isInputRequiredResult` only reads `resultType`.
 */
const failedResult = (job: JobDef, result: unknown) =>
  job.guarded &&
  (!isObject(result) ||
    result.isError === true ||
    isInputRequiredResult(result));

/**
 * An `apply()` that failed after changing something throws an error with `partial: true`
 * (`PartialApplyError`). Checked structurally, so a second copy of this package still counts.
 */
export const isPartial = (e: unknown): e is Error =>
  e instanceof Error && (e as { partial?: unknown }).partial === true;

/**
 * An `apply()` that failed part-way: say what it says, never "nothing changed". Reservations stay
 * held, which can only over-count, since what was used is unknown.
 */
function partialResult(
  hp: HashedPlan,
  e: Error,
  how: 'auto' | 'approved',
): CallToolResult {
  return errorResult([
    `✗ ${how === 'approved' ? 'approved, but ' : ''}${hp.plan.summary} failed part-way: ${e.message}${how === 'approved' ? ' The approval is used up.' : ''}`,
  ]);
}

/** Release reservations; one that can't be released stays held, which only over-counts. */
const releaseAll = (y: Yea, held: Reservation[]) =>
  Promise.allSettled(held.map((r) => y.store.release(r)));

/** Step 11: apply once, then settle and record the receipt. */
export async function runPlan(
  call: Call,
  hp: HashedPlan,
  held: Reservation[],
  how: 'auto' | 'approved',
): Promise<Result> {
  let result: unknown;

  try {
    result = await hp.plan.apply();
  } catch (e) {
    if (isPartial(e)) {
      return partialResult(hp, e, how);
    }

    await releaseAll(call.y, held);

    return errorResult([
      `✗ ${how === 'approved' ? 'approved, but ' : ''}${hp.plan.summary} failed: ${errorMessage(e)}; nothing changed.${how === 'approved' ? ' The approval is used up: calling again asks again.' : ''}`,
    ]);
  }

  return finish(call, hp, held, { result, auto: how === 'auto' });
}

/** A value as JSON carries it, or null and why not (a circular or bigint result can't go). */
function jsonSafe(v: unknown): { value: unknown; note: string | null } {
  if (v === undefined) {
    return { value: undefined, note: null };
  }

  try {
    return { value: JSON.parse(JSON.stringify(v)) as unknown, note: null };
  } catch (e) {
    return {
      value: null,
      note: `its result couldn't be serialized (${errorMessage(e).split('\n')[0]}), so it isn't shown or kept`,
    };
  }
}

/** The receipt a successful job leaves (SPEC-approval §8's JobReceipt). */
function receiptFor(call: Call, hp: HashedPlan, result: unknown): JobReceipt {
  const p = hp.plan;

  return {
    id: newReceiptId(),
    service: call.policy.server,
    proposal: hp.planHash,
    capability: hp.tool,
    summary: p.summary,
    at: call.now,
    effects: p.effects,
    ...(p.uses && Object.keys(p.uses).length ? { uses: p.uses } : {}),
    undo:
      hp.undoable && p.undoWindow !== undefined
        ? { until: call.now + p.undoWindow }
        : null,
    tool: hp.tool,
    input: call.input,
    planHash: hp.planHash,
    sub: call.sub,
    ...(result === undefined ? {} : { result }),
  };
}

/**
 * Everything after a successful `apply()`. The action has happened, so nothing here may say
 * "nothing was run": any failure is reported as the action having happened, with whether undo
 * is available.
 */
async function finish(
  call: Call,
  hp: HashedPlan,
  held: Reservation[],
  done: { result: unknown; auto: boolean },
): Promise<Result> {
  const saved: { receipt: JobReceipt | null } = { receipt: null };

  try {
    return await recorded(call, hp, held, { ...done, saved });
  } catch (e) {
    return happened(call, hp, `then ${errorMessage(e)}`, saved.receipt);
  }
}

/** Handle a guarded tool's failed result, or settle, store the receipt, and return it. */
async function recorded(
  call: Call,
  hp: HashedPlan,
  held: Reservation[],
  done: {
    result: unknown;
    auto: boolean;
    /** Set once the receipt is stored, so a later failure can say undo is available. */
    saved: { receipt: JobReceipt | null };
  },
): Promise<Result> {
  const safe = jsonSafe(done.result);

  if (failedResult(call.job, done.result)) {
    await releaseAll(call.y, held);

    return safe.note
      ? errorResult([`✗ ${hp.plan.summary} failed, and ${safe.note}`])
      : (safe.value as Result);
  }

  const receipt = receiptFor(call, hp, safe.value);

  await Promise.all(held.map((r) => call.y.store.settle(r)));
  await call.y.store.putReceipt(receipt);
  done.saved.receipt = receipt;

  if (safe.note) {
    return happened(call, hp, safe.note, receipt);
  }

  if (call.job.guarded) {
    const r = safe.value as CallToolResult;

    return { ...r, _meta: { ...r._meta, 'dev.yea/receipt': receipt } };
  }

  return receiptResult(receipt, done.auto);
}

/** The action happened, but something after it didn't: say so, and whether undo is available. */
function happened(
  call: Call,
  hp: HashedPlan,
  what: string,
  receipt: JobReceipt | null,
): Result {
  const undo = !receipt
    ? "its receipt wasn't saved, so it can't be undone"
    : receipt.undo
      ? `undo is available with receipt ${receipt.id}`
      : `receipt ${receipt.id}; it can't be undone`;

  const lines = [`✓ ${hp.plan.summary} happened, but ${what}; ${undo}.`];
  const structured = { receipt, result: null };

  // A guarded tool's outputSchema only describes the original's own results.
  return call.job.ownResultsAreErrors?.()
    ? errorResult(lines, structured)
    : textResult(lines, structured);
}
