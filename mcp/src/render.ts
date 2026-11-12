/**
 * What a job call returns (SPEC-mcp-ts, "Results and annotations"): Lens text for the model,
 * and the same as data in `structuredContent`. Service text in the Lens (summaries, effects,
 * questions, a receipt) is untrusted, so it's escaped with `printable`; the data stays raw.
 */
import type { CallToolResult } from '@modelcontextprotocol/server';
import {
  type Clarification,
  type HashedPlan,
  howToApprove,
  type JobReceipt,
  lean,
  type PlanConsentCode,
  planLines,
  printable,
  shownPlan,
  untrustedLens,
} from '@yea-protocol/sdk';
import { errorResult, NOTHING_RAN, refused, textResult } from './result.js';

/** A plan as data: what the model and the person see, never `apply` or `data`. */
function planView(hp: HashedPlan) {
  const { undoWindow, ...shown } = shownPlan(hp);

  return {
    planHash: hp.planHash,
    ...shown,
    undo: undoWindow === undefined ? null : { window: undoWindow },
  };
}

const plansText = (plans: HashedPlan[]) => [
  `${plans.length} plan${plans.length === 1 ? '' : 's'}:`,
  ...plans.flatMap((hp, i) => planLines(shownPlan(hp), i + 1)),
];

/**
 * `preview: true`: the plans, and nothing run or stored. `asError` is for a guarded tool with an
 * `outputSchema`, which only describes its real results: a success here would fail the client's
 * output validation.
 */
export function previewResult(
  plans: HashedPlan[],
  asError: boolean,
): CallToolResult {
  const lines = [
    `preview: ${NOTHING_RAN}`,
    ...plansText(plans),
    'Call again without preview to run the first plan, or to ask the user.',
  ];
  const structured = { plans: plans.map(planView) };

  return asError
    ? errorResult(lines, structured)
    : textResult(lines, structured);
}

/** No approval could be asked for here: the plans, and a consent code (and its id) for each. */
export function consentResult(
  why: string,
  plans: HashedPlan[],
  codes: PlanConsentCode[],
  unavailable: string | null,
): CallToolResult {
  const tail = unavailable
    ? [`No consent can be accepted: ${unavailable}.`]
    : howToApprove(
        plans.map((hp) => hp.planHash),
        codes,
      );

  return refused(
    `approval needed: ${printable(why)}`,
    [...plansText(plans), ...tail],
    {
      plans: plans.map(planView),
      codes,
    },
  );
}

/** A job's receipt as Lens (the protocol's RECEIPT), with the job's result. */
export function receiptResult(
  receipt: JobReceipt,
  auto: boolean,
): CallToolResult {
  const line = untrustedLens({
    yea: 1,
    id: receipt.id,
    re: receipt.proposal,
    kind: 'RECEIPT',
    receipt,
    auto,
  });

  return textResult([line], { receipt, result: receipt.result ?? null });
}

/** A plan's question back to the model, with what to call again with for each answer. */
export function clarifyResult(c: Clarification): CallToolResult {
  const { question, options } = c.clarify;

  return textResult(
    [
      `? ${printable(question)}`,
      ...options.map((o, i) =>
        printable(
          `  ${i + 1}. ${printable(o.label)} → ${lean(o.params).split('\n').join(', ')}`,
        ),
      ),
    ],
    { clarify: c.clarify },
  );
}
