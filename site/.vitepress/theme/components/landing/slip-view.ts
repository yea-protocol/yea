/**
 * What the proposal slip shows, from real frames: a proposal waiting on consent, its receipt
 * once approved, and the undo. Pure: the SDK's formatters come in as a kit.
 *
 * Its only runtime import names its `.ts` file, so the recording script and the tests can
 * load it under Node.
 */
import type { ConsentRequest, Proposal, Receipt } from '@yea-protocol/sdk';
import { type FactsKit, proposalFacts } from '../proposal-facts.ts';

export type SlipKit = FactsKit;

/** A proposal as the slip shows it, waiting on the person. */
export interface SlipView {
  id: string;
  service: string;
  summary: string;
  effects: string[];
  uses: string;
  risk: string;
  undo: string;
  hash: string;
  /** The service's reason for asking. */
  reason: string;
  /** When the proposal expires, in unix seconds. */
  expires: number;
}

/** A committed receipt. */
export interface ReceiptView {
  id: string;
  /** When the undo window closes, in unix seconds, or null if it can't be undone. */
  until: number | null;
  /** The same, as `2026-09-29 14:00 UTC`. */
  undoUntil: string | null;
  result: string[];
}

/** An undo: the new receipt and the one it reverses. */
export interface UndoneView {
  id: string;
  undoes: string;
}

/** A unix time as `2026-09-29 14:00 UTC`. */
export const utcMinute = (unix: number) =>
  `${new Date(unix * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

/** A unix time as `14:00 UTC`. */
export const utcClock = (unix: number) => utcMinute(unix).slice(11);

export function slipView(
  kit: SlipKit,
  p: Proposal,
  consent: ConsentRequest,
  reason: string,
): SlipView {
  const f = proposalFacts(kit, p);

  return {
    id: p.id,
    service: consent.service,
    summary: p.summary,
    effects: f.effects,
    uses: f.uses ?? 'nothing',
    risk: f.risk,
    undo: f.undo,
    hash: consent.hash,
    reason,
    expires: p.expires,
  };
}

/** What a proposal spends in dollars, from its `spend` use in USD, or null. */
export function spendOf(p: Proposal): number | null {
  const q = p.uses?.spend;

  return q && q.unit === 'USD' ? q.amount / 10 ** (q.scale ?? 0) : null;
}

/** A result object as `key: value` lines. */
const resultLines = (result: unknown): string[] =>
  typeof result === 'object' && result !== null
    ? Object.entries(result).map(([k, v]) => `${k}: ${String(v)}`)
    : [];

export const receiptView = (r: Receipt): ReceiptView => ({
  id: r.id,
  until: r.undo ? r.undo.until : null,
  undoUntil: r.undo ? utcMinute(r.undo.until) : null,
  result: resultLines(r.result),
});

export const undoneView = (r: Receipt): UndoneView => ({
  id: r.id,
  undoes: r.undoes ?? '',
});

/** Text split so dates (`2026-09-29`) stay whole: they are the parts marked `date`. */
export function keepDates(text: string): { text: string; date: boolean }[] {
  return text
    .split(/(\d{4}-\d{2}-\d{2})/)
    .filter((t) => t !== '')
    .map((t) => ({ text: t, date: /^\d{4}-\d{2}-\d{2}$/.test(t) }));
}
