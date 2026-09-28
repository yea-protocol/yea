/**
 * What a job call returns (SPEC-mcp-ts, "Results and annotations"): Lens text for the model,
 * and the same as data in `structuredContent`. The bridge shares the result and refusal helpers.
 */
import type {
  CallToolResult,
  ToolAnnotations,
} from '@modelcontextprotocol/server';
import {
  type Clarification,
  effectLine,
  fmtDuration,
  fmtUses,
  type HashedPlan,
  type JobReceipt,
  lean,
  lens,
} from '@yea-protocol/sdk';
import type { Obj } from './util.js';

/** A job changes things: destructive, so clients shouldn't auto-approve it. Hints only. */
export const JOB_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
};

/** `undo` changes things too, but undoing a receipt twice does nothing more. */
export const UNDO_ANNOTATIONS: ToolAnnotations = {
  ...JOB_ANNOTATIONS,
  idempotentHint: true,
};

/** A read never changes anything. */
export const READ_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
};

/** What every refusal says, so the model knows nothing happened. */
export const NOTHING_RAN = 'nothing was run';

/** A job retry whose approval state is bad or used: `yea()` minted it, and it's spent. */
export const INVALID_APPROVAL =
  'this approval is invalid, expired, already used, or for another call; nothing was run. Call the tool again to ask again.';

/** Any approval state on a bridge job call: the bridge mints none yet (TODO(#73)). */
export const UNMINTED_STATE =
  'this approval state is invalid, expired or already used; nothing was run. Call the tool again without it.';

const text = (lines: string[]) => [
  { type: 'text' as const, text: lines.join('\n') },
];

/** Lines of text for the model, and `structured` as data. */
export function textResult(lines: string[], structured?: Obj): CallToolResult {
  return {
    content: text(lines),
    ...(structured ? { structuredContent: structured } : {}),
  };
}

/** A refusal or failure: `isError`, so the model sees the reason and the fix. */
export function errorResult(lines: string[], structured?: Obj): CallToolResult {
  return { ...textResult(lines, structured), isError: true };
}

/** `✗ <why>; nothing was run`, then any lines that help. */
export const refused = (why: string, more: string[] = [], structured?: Obj) =>
  errorResult([`✗ ${why}; ${NOTHING_RAN}`, ...more], structured);

/** A plan as data: what the model and the person see, never `apply` or `data`. */
function planView(hp: HashedPlan) {
  const p = hp.plan;

  return {
    planHash: hp.planHash,
    summary: p.summary,
    effects: p.effects,
    ...(p.uses && Object.keys(p.uses).length ? { uses: p.uses } : {}),
    risk: hp.risk,
    undo:
      hp.undoable && p.undoWindow !== undefined
        ? { window: p.undoWindow }
        : null,
  };
}

/** One plan as Lens: summary, effects, then what it uses, risk and undo. */
function planLines(n: number, hp: HashedPlan): string[] {
  const v = planView(hp);
  const attrs = [
    ...(v.uses ? [`uses: ${fmtUses(v.uses)}`] : []),
    `risk: ${v.risk}`,
    `undo: ${v.undo ? fmtDuration(v.undo.window) : 'never'}`,
  ];

  return [
    `[${n}] ${v.summary}`,
    ...v.effects.map((e) => `  ${effectLine(e)}`),
    `  ${attrs.join(' · ')}`,
  ];
}

const plansText = (plans: HashedPlan[]) => [
  `${plans.length} plan${plans.length === 1 ? '' : 's'}:`,
  ...plans.flatMap((hp, i) => planLines(i + 1, hp)),
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

/** No approval could be asked for here: the plans, and a consent code for each. */
export function consentResult(
  why: string,
  plans: HashedPlan[],
  codes: { planHash: string; code: string }[],
  unavailable: string | null,
): CallToolResult {
  const tail = unavailable
    ? [`No consent can be accepted: ${unavailable}.`]
    : [
        'Ask the user to run `yea approve <code>` in their terminal, then call again.',
        ...codes.map((c) => `  code for [${codeNumber(plans, c)}]: ${c.code}`),
      ];

  return refused(`approval needed: ${why}`, [...plansText(plans), ...tail], {
    plans: plans.map(planView),
    codes,
  });
}

const codeNumber = (plans: HashedPlan[], c: { planHash: string }) =>
  plans.findIndex((hp) => hp.planHash === c.planHash) + 1;

/** A job's receipt as Lens (the protocol's RECEIPT), with the job's result. */
export function receiptResult(
  receipt: JobReceipt,
  auto: boolean,
): CallToolResult {
  const line = lens({
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
      `? ${question}`,
      ...options.map(
        (o, i) =>
          `  ${i + 1}. ${o.label} → ${lean(o.params).split('\n').join(', ')}`,
      ),
    ],
    { clarify: c.clarify },
  );
}
