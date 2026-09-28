/**
 * The approval form (docs/framework/SPEC-approval.md §3): the message listing
 * each plan, escaped, and the schema of what the person answers.
 */
import type { HashedPlan, Policy } from '../approval.js';
import { fmtDuration, safeEffectLine } from '../lens.js';
import { atLeast } from '../risk.js';
import { printable } from '../text.js';
import { fmtUses } from '../uses.js';
import { type PhraseFor, withFallback } from './phrase.js';

export interface ApprovalForm {
  message: string;
  requestedSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
  /** The plan hashes the form offers; the state carries these. */
  offered: string[];
}

/**
 * One plan as the person reads it: summary, effects, then what it uses, risk and undo. Service
 * text is untrusted, so it's escaped: a summary can't forge a line or hide characters.
 */
function planText(n: number, hp: HashedPlan, phrase: string | null): string[] {
  const p = hp.plan;
  const attrs = [
    ...(p.uses && Object.keys(p.uses).length
      ? [`uses: ${fmtUses(p.uses)}`]
      : []),
    `risk: ${hp.risk}`,
    `undo: ${hp.undoable && p.undoWindow ? fmtDuration(p.undoWindow) : 'never'}`,
  ];

  return [
    `[${n}] ${printable(p.summary)}`,
    ...p.effects.map((e) => `  ${safeEffectLine(e)}`),
    `  ${attrs.join(' · ')}`,
    ...(phrase === null ? [] : [`  to approve, type: ${printable(phrase)}`]),
  ];
}

/** `[n], [m]` for the listed plans, numbered as in the message. */
const numbers = (plans: HashedPlan[], some: HashedPlan[]) =>
  some.map((hp) => `[${plans.indexOf(hp) + 1}]`).join(', ');

/**
 * The form-mode elicitation for these plans (§3). Denied plans and plans at or above
 * `outOfBand` are listed but not offered. Null when nothing can be offered: the caller then
 * fails closed with consent codes (§6).
 */
export function buildForm(
  plans: HashedPlan[],
  why: string,
  policy: Pick<Policy, 'outOfBand' | 'deny'>,
  phraseFor: PhraseFor,
): ApprovalForm | null {
  const phrase = withFallback(phraseFor);
  const denied = plans.filter((hp) => policy.deny.includes(hp.tool));
  const outside = plans.filter(
    (hp) => !denied.includes(hp) && atLeast(hp.risk, policy.outOfBand),
  );
  const offered = plans.filter(
    (hp) => !denied.includes(hp) && !outside.includes(hp),
  );

  if (!offered.length) {
    return null;
  }

  const message = [
    `Approval needed: ${printable(why)}.`,
    '',
    ...plans.flatMap((hp, i) =>
      planText(i + 1, hp, offered.includes(hp) ? phrase(hp) : null),
    ),
    ...(outside.length
      ? [
          '',
          `Not offered here (approve outside the chat): ${numbers(plans, outside)}`,
        ]
      : []),
    ...(denied.length
      ? ['', `Never allowed by your policy: ${numbers(plans, denied)}`]
      : []),
  ].join('\n');

  return {
    message,
    requestedSchema: formSchema(offered, phrase),
    offered: offered.map((hp) => hp.planHash),
  };
}

function formSchema(
  offered: HashedPlan[],
  phraseFor: PhraseFor,
): ApprovalForm['requestedSchema'] {
  const confirm = {
    type: 'string',
    title: 'Confirm',
    description:
      offered.length === 1
        ? `Type "${printable(phraseFor(offered[0]))}" to approve.`
        : "Type the chosen plan's phrase, shown next to it above.",
  };

  if (offered.length === 1) {
    return {
      type: 'object',
      properties: { confirm },
      required: ['confirm'],
    };
  }

  return {
    type: 'object',
    properties: {
      plan: {
        type: 'string',
        title: 'Plan',
        oneOf: offered.map((hp) => ({
          const: hp.planHash,
          title: printable(hp.plan.summary),
        })),
      },
      confirm,
    },
    required: ['plan', 'confirm'],
  };
}
