/**
 * The playground's example params per capability, and the scenarios behind the preset buttons:
 * which service, verb and params each one sends, and which proposal it then commits.
 */
import type { Verb } from '@yea-protocol/sdk';
import type { RequestForm, ServiceKey } from './model';

export type PresetKind =
  | 'auto'
  | 'clarify'
  | 'consent'
  | 'refund'
  | 'budget'
  | 'typo';

/** Example params, keyed by capability name. */
export type Examples = Record<string, object>;

/** A scenario: the request it sends, and which of the proposals it gets back to commit next. */
export interface Preset {
  service: ServiceKey;
  verb: Verb;
  capability: string;
  params: object;
  form: Partial<RequestForm>;
  commit?: 'first' | 'last';
}

/** The preset buttons, in order. */
export const PRESET_BUTTONS: readonly { kind: PresetKind; label: string }[] = [
  { kind: 'auto', label: 'Move a meeting in one round trip' },
  { kind: 'clarify', label: 'Ambiguous request' },
  { kind: 'consent', label: 'Order over the limit' },
  { kind: 'refund', label: "A refund that can't be undone" },
  { kind: 'budget', label: '60 items in 250 tokens' },
  { kind: 'typo', label: 'A typo that teaches' },
];

/** The UTC date `n + 1` days from today, as YYYY-MM-DD. */
export const day = (n: number) =>
  new Date(
    Date.UTC(
      new Date().getUTCFullYear(),
      new Date().getUTCMonth(),
      new Date().getUTCDate(),
    ) +
      (n + 1) * 864e5,
  )
    .toISOString()
    .slice(0, 10);

/** Example params for every capability, with dates from today. */
export const examples = (): Examples => ({
  'calendar.agenda': { query: 'Ana' },
  'calendar.free': { day: day(2) },
  'calendar.reschedule': { event: '1:1 with Ana', day: day(2) },
  'calendar.cancel': { event: 'Standup' },
  'calendar.book': {
    title: 'Coffee with Sam',
    with: ['sam@example.com'],
    day: day(1),
  },
  'shop.search': { tag: 'vegan', max_cal: 700 },
  'shop.order': {
    items: [
      { sku: 'm047', qty: 2 },
      { sku: 'm055', qty: 2 },
    ],
    deliver: day(1),
  },
  'shop.tip': { order: 'o1001', usd: 5 },
  'billing.customers': { status: 'active' },
  'billing.customer': { who: 'Chen' },
  'billing.refund': { who: 'Chen' },
  'billing.change_plan': { who: 'Dana', plan: 'pro' },
  'billing.cancel': { who: 'Ben' },
});

/** The scenario behind a preset button. */
export function presetFor(kind: PresetKind, ex: Examples): Preset {
  const intent = (service: ServiceKey, capability: string) => ({
    service,
    verb: 'INTENT' as const,
    capability,
  });

  switch (kind) {
    case 'auto':
      return {
        ...intent('calendar', 'calendar.reschedule'),
        params: ex['calendar.reschedule'],
        form: { auto: true },
      };
    case 'clarify':
      return {
        ...intent('calendar', 'calendar.reschedule'),
        params: { event: 'Ana', day: day(2) },
        form: {},
      };
    // Over the per-action limit, so auto falls back to proposals; committing one then asks the human.
    case 'consent':
      return {
        ...intent('shop', 'shop.order'),
        params: ex['shop.order'],
        form: { auto: true },
        commit: 'first',
      };
    // A refund can't be undone, so it's never auto-committed, and it's above the policy's risk.
    case 'refund':
      return {
        ...intent('billing', 'billing.refund'),
        params: ex['billing.refund'],
        form: { auto: true },
        commit: 'last',
      };
    case 'budget':
      return {
        service: 'shop',
        verb: 'ASK',
        capability: 'shop.search',
        params: {},
        form: { useBudget: true, budget: 250 },
      };
    case 'typo':
      return {
        service: 'calendar',
        verb: 'ASK',
        capability: 'calendar.agenda',
        params: { dya: day(0) },
        form: {},
      };
  }
}
