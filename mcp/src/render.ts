/**
 * What a job call returns (SPEC-mcp-ts, "Results and annotations"): Lens text for the model,
 * and the same as data in `structuredContent`.
 */
import type { CallToolResult } from '@modelcontextprotocol/server';
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

/** A plan as data: what the model and the person see, never `apply` or `data`. */
export function planView(hp: HashedPlan) {
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

export const plansText = (plans: HashedPlan[]) => [
  `${plans.length} plan${plans.length === 1 ? '' : 's'}:`,
  ...plans.flatMap((hp, i) => planLines(i + 1, hp)),
];

const text = (lines: string[]) => [
  { type: 'text' as const, text: lines.join('\n') },
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
  return {
    content: text([
      'preview: nothing was run',
      ...plansText(plans),
      'Call again without preview to run the first plan, or to ask the user.',
    ]),
    structuredContent: { plans: plans.map(planView) },
    ...(asError ? { isError: true } : {}),
  };
}

/** A refusal or failure: `isError`, so the model sees the reason and the fix. */
export function errorResult(
  lines: string[],
  structured?: Record<string, unknown>,
): CallToolResult {
  return {
    content: text(lines),
    isError: true,
    ...(structured ? { structuredContent: structured } : {}),
  };
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

  return errorResult(
    [
      `✗ approval needed: ${why}; nothing was run`,
      ...plansText(plans),
      ...tail,
    ],
    { plans: plans.map(planView), codes },
  );
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

  return {
    content: text([line]),
    structuredContent: { receipt, result: receipt.result ?? null },
  };
}

/** A plan's question back to the model, with what to call again with for each answer. */
export function clarifyResult(c: Clarification): CallToolResult {
  const { question, options } = c.clarify;

  return {
    content: text([
      `? ${question}`,
      ...options.map(
        (o, i) =>
          `  ${i + 1}. ${o.label} → ${lean(o.params).split('\n').join(', ')}`,
      ),
    ]),
    structuredContent: { clarify: c.clarify },
  };
}
