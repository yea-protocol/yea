/**
 * The Lens lines of each reply kind but PROPOSALS (SPEC §9.2): a brief,
 * a clarifying question, a receipt, an error and an event.
 */
import type {
  Brief,
  Clarify,
  ErrorReply,
  Event,
  ParamSchema,
  ReceiptReply,
} from '../types.js';
import { isObject } from '../util.js';
import { effectLine, fmtDuration, fmtTime } from './format.js';
import { entry } from './notation.js';

function paramList(params: ParamSchema | undefined): string {
  if (!params) {
    return '()';
  }

  const ty = (t: ParamSchema[string]): string =>
    typeof t === 'string'
      ? t
      : Array.isArray(t)
        ? `[${ty(t[0])}]`
        : `{${paramList(t).slice(1, -1)}}`;

  return (
    '(' +
    Object.entries(params)
      .map(([k, t]) => `${k}: ${ty(t)}`)
      .join(', ') +
    ')'
  );
}

export function briefLines(r: Brief): string[] {
  const out = [`# ${r.service.name} (${r.service.id})`];

  if (r.service.summary) {
    out.push(r.service.summary);
  }

  for (const c of r.capabilities) {
    out.push(
      `${c.kind} ${c.name}${paramList(c.params)}${c.summary ? ` — ${c.summary}` : ''}${c.risk ? ` [risk:${c.risk}]` : ''}`,
    );
  }

  return out;
}

export function clarifyLines(r: Clarify): string[] {
  return [
    `? ${r.question}`,
    ...r.options.map((o, i) => `  ${i + 1}. ${o.label}`),
  ];
}

export function receiptLines(r: ReceiptReply): string[] {
  const rc = r.receipt;
  const tag = `(receipt ${rc.id})${r.replay ? ' (replay)' : ''}`;
  const out = rc.undoes
    ? [`↶ undid ${rc.undoes}: ${rc.summary} ${tag}`]
    : [`✓ ${rc.summary} ${tag} · ${undoUntil(rc.undo)}`];

  // The model already saw the effects in the proposal, unless the service auto-committed.
  if (r.auto) {
    out.push(...(rc.effects ?? []).map((e) => `  ${effectLine(e)}`));
  }

  if (rc.result !== undefined) {
    out.push(...entry('result', rc.result, 1));
  }

  return out;
}

/** `undo until {time}` for an undo object with an `until`; anything else is `irreversible`. */
function undoUntil(undo: unknown): string {
  return isObject(undo) && 'until' in undo
    ? `undo until ${fmtTime(undo.until)}`
    : 'irreversible';
}

export function errorLines(r: ErrorReply): string[] {
  const out = [`✗ ${r.code}: ${r.message}`];

  for (const f of r.fix ?? []) {
    out.push(
      `  fix: ${f.say}${f.params ? ` → params ${JSON.stringify(f.params)}` : ''}`,
    );
  }

  if (r.need?.length) {
    out.push(`  need: ${JSON.stringify(r.need)}`);
  }

  if (r.consent) {
    out.push(
      `  consent: principal must approve ${r.consent.hash} (${r.consent.summary})`,
    );
  }

  if (typeof r.retry === 'number') {
    out.push(`  retry in: ${fmtDuration(r.retry)}`);
  }

  return out;
}

/** The percentage is shown only for a `progress` in [0, 1]; any other value is left out. */
export function eventLine(r: Event): string {
  const p: unknown = r.progress;
  const progress =
    typeof p === 'number' && p >= 0 && p <= 1
      ? ` (${Math.floor(p * 100 + 0.5)}%)`
      : '';

  return `… ${r.message}${progress}`;
}
