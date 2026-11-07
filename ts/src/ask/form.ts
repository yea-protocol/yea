/**
 * The approval form (docs/framework/SPEC-approval.md §3): the message listing
 * each plan, escaped, and the schema of what the person answers.
 */
import {
  type HashedPlan,
  type Policy,
  ruledOut,
  shownPlan,
} from '../approval.js';
import { printable } from '../text.js';
import { type PhraseFor, withFallback } from './phrase.js';
import { planLines } from './plan-text.js';

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

/** One plan as the person reads it, then its phrase when it is offered. */
const planText = (n: number, hp: HashedPlan, phrase: string | null) => [
  ...planLines(shownPlan(hp), n),
  ...(phrase === null ? [] : [`  to approve, type: ${printable(phrase)}`]),
];

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
  const rule = (hp: HashedPlan) => ruledOut(hp, policy)?.kind;
  const denied = plans.filter((hp) => rule(hp) === 'denied');
  const outside = plans.filter((hp) => rule(hp) === 'out-of-band');
  const offered = plans.filter((hp) => !rule(hp));

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
