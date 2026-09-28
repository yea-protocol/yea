/**
 * What the proposal slip shows, from real frames: a proposal waiting on consent, its receipt
 * once approved, and the undo. Pure: the SDK's formatters come in as a kit.
 *
 * No runtime imports, so the recording script and the tests can load it under Node.
 */
import type {
  ConsentRequest,
  effectLine,
  fmtDuration,
  fmtQuantity,
  Proposal,
  Receipt,
} from '@yea-protocol/sdk';

/** The SDK formatters the views need. */
export interface SlipKit {
  effectLine: typeof effectLine;
  fmtQuantity: typeof fmtQuantity;
  fmtDuration: typeof fmtDuration;
}

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
}

/** A committed receipt. */
export interface ReceiptView {
  id: string;
  /** When the undo window closes, as `2026-09-29 14:00 UTC`, or null if it can't be undone. */
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

/** What a proposal uses, as `spend 53.95 USD`, or `nothing`. */
function usesText(kit: SlipKit, p: Proposal): string {
  const uses = p.uses ?? {};
  const names = Object.keys(uses).sort();

  return names.length
    ? names.map((n) => `${n} ${kit.fmtQuantity(uses[n])}`).join(', ')
    : 'nothing';
}

export function slipView(
  kit: SlipKit,
  p: Proposal,
  consent: ConsentRequest,
  reason: string,
): SlipView {
  return {
    id: p.id,
    service: consent.service,
    summary: p.summary,
    effects: p.effects.map((e) => kit.effectLine(e)),
    uses: usesText(kit, p),
    risk: p.risk,
    undo: p.undo
      ? `within ${kit.fmtDuration(p.undo.window)}`
      : "can't be undone",
    hash: consent.hash,
    reason,
  };
}

/** A result object as `key: value` lines. */
const resultLines = (result: unknown): string[] =>
  typeof result === 'object' && result !== null
    ? Object.entries(result).map(([k, v]) => `${k}: ${String(v)}`)
    : [];

export const receiptView = (r: Receipt): ReceiptView => ({
  id: r.id,
  undoUntil: r.undo ? utcMinute(r.undo.until) : null,
  result: resultLines(r.result),
});

export const undoneView = (r: Receipt): UndoneView => ({
  id: r.id,
  undoes: r.undoes ?? '',
});
