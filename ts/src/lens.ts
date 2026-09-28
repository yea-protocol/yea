/**
 * Lens (SPEC §9): the canonical, compact text a model reads instead of raw JSON.
 * Deterministic: two conforming implementations produce byte-identical output.
 */
import { quote } from './canonical.js';
import { printable } from './text.js';
import type {
  Brief,
  Clarify,
  Effect,
  ErrorReply,
  Event,
  More,
  ParamSchema,
  Proposal,
  ReceiptReply,
  Reply,
} from './types.js';
import { fmtUses } from './uses.js';
import { isObject } from './util.js';

const BARE = /^[A-Za-z0-9_@./+\-:() '!?&%$#*=<>~^]+$/;
const NUMERIC = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/;
const RESERVED = new Set(['-', 'true', 'false', 'null']);
const pad = (n: number) => '  '.repeat(n);

const isScalar = (v: unknown): v is string | number | boolean | null =>
  v === null ||
  typeof v === 'string' ||
  typeof v === 'number' ||
  typeof v === 'boolean';

export function scalar(v: unknown): string {
  if (v === null || v === undefined) {
    return '-';
  }

  if (typeof v === 'boolean') {
    return v ? 'true' : 'false';
  }

  if (typeof v === 'number') {
    return Number.isFinite(v) ? String(v) : '-';
  }

  const s = String(v);

  if (
    BARE.test(s) &&
    s[0] !== ' ' &&
    s[s.length - 1] !== ' ' &&
    !RESERVED.has(s) &&
    !NUMERIC.test(s)
  ) {
    return s;
  }

  return quote(s);
}

function isTable(arr: unknown[]): arr is Record<string, unknown>[] {
  if (!arr.every(isObject)) {
    return false;
  }

  const first = Object.keys(arr[0]);

  if (first.length === 0) {
    return false;
  }

  return arr.every((o) => {
    const ks = Object.keys(o);

    return (
      ks.length === first.length &&
      ks.every((k, i) => k === first[i]) &&
      ks.every((k) => isScalar(o[k]))
    );
  });
}

function entries(obj: Record<string, unknown>, n: number): string[] {
  const out: string[] = [];

  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) {
      out.push(...entry(k, v, n));
    }
  }

  return out;
}

function entry(key: string, v: unknown, n: number): string[] {
  const k = pad(n) + scalar(key);

  if (isScalar(v)) {
    return [`${k}: ${scalar(v)}`];
  }

  if (Array.isArray(v)) {
    if (v.length === 0) {
      return [`${k}: []`];
    }

    if (v.every(isScalar)) {
      return [`${k}: [${v.map(scalar).join(', ')}]`];
    }

    if (isTable(v)) {
      const cols = Object.keys(v[0]);

      return [
        `${k}[${v.length}]{${cols.map(scalar).join(',')}}:`,
        ...v.map(
          (row) => pad(n + 1) + cols.map((c) => scalar(row[c])).join(','),
        ),
      ];
    }

    return [
      `${k}[${v.length}]:`,
      ...v.flatMap((item) => listItem(item, n + 1)),
    ];
  }

  if (isObject(v)) {
    const body = entries(v, n + 1);

    return body.length ? [`${k}:`, ...body] : [`${k}: {}`];
  }

  return [`${k}: -`];
}

function listItem(item: unknown, n: number): string[] {
  const dash = `${pad(n)}- `;

  if (isScalar(item)) {
    return [dash + scalar(item)];
  }

  if (Array.isArray(item)) {
    return [
      dash +
        (item.every(isScalar)
          ? `[${item.map(scalar).join(', ')}]`
          : JSON.stringify(item)),
    ];
  }

  if (isObject(item)) {
    const body = entries(item, n + 1);

    if (!body.length) {
      return [`${dash}{}`];
    }

    return [dash + body[0].slice(pad(n + 1).length), ...body.slice(1)];
  }

  return [`${dash}-`];
}

/** Render any JSON value in lean notation (SPEC §9.1). */
export function lean(v: unknown): string {
  if (isScalar(v)) {
    return scalar(v);
  }

  if (Array.isArray(v)) {
    return entry('items', v, 0).join('\n');
  }

  if (isObject(v)) {
    const lines = entries(v, 0);

    return lines.length ? lines.join('\n') : '{}';
  }

  return '-';
}

// ---- formatting helpers (SPEC §9.2) ----

export function fmtTime(unix: number): string {
  const iso = new Date(unix * 1000).toISOString(); // YYYY-MM-DDTHH:MM:SS.sssZ
  const secs = iso.slice(17, 19);

  return `${iso.slice(0, 16) + (secs === '00' ? '' : `:${secs}`)}Z`;
}

export function fmtDuration(s: number): string {
  if (s !== 0 && s % 86400 === 0) {
    return `${s / 86400}d`;
  }

  if (s !== 0 && s % 3600 === 0) {
    return `${s / 3600}h`;
  }

  if (s !== 0 && s % 60 === 0) {
    return `${s / 60}m`;
  }

  return `${s}s`;
}

const SYM: Record<string, string> = {
  create: '+',
  update: '~',
  delete: '-',
  send: '>',
  other: '*',
};

export function effectLine(e: Effect): string {
  let s = `${SYM[e.op] ?? '*'} ${e.op} ${e.target}${e.field ? `.${e.field}` : ''}`;

  if (e.from !== undefined || e.to !== undefined) {
    s += `: ${scalar(e.from ?? null)} → ${scalar(e.to ?? null)}`;
  }

  if (e.detail) {
    s += ` — ${e.detail}`;
  }

  return s;
}

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

function moreLines(more: More[] | undefined): string[] {
  return (more ?? []).map(
    (m) =>
      `… ${m.remaining} more at ${m.path} — EXPAND ${m.handle} (~${m.est} tokens)`,
  );
}

const ATTRS: [string, (p: Proposal) => string][] = [
  // Absent means nothing to show; anything else present renders, and a malformed one as `?`.
  ['uses', (p) => (p.uses === undefined ? '' : fmtUses(p.uses))],
  ['risk', (p) => p.risk],
  ['undo', (p) => (p.undo ? fmtDuration(p.undo.window) : 'never')],
  ['expires', (p) => fmtTime(p.expires)],
];

/** `k: v` for each attribute, joined with ` · `; an attribute that renders empty (no `uses`) is left out. */
function attrLine(attrs: typeof ATTRS, p: Proposal): string {
  return attrs
    .map(([k, f]) => [k, f(p)])
    .filter(([, v]) => v !== '')
    .map(([k, v]) => `${k}: ${v}`)
    .join(' · ');
}

function proposalsLines(ps: Proposal[]): string[] {
  // Attributes identical across all (N ≥ 2) proposals are stated once, in the header.
  const shared =
    ps.length >= 2
      ? ATTRS.filter(([, f]) => ps.every((p) => f(p) === f(ps[0])))
      : [];
  const own = ATTRS.filter((a) => !shared.includes(a));
  const header = attrLine(shared, ps[0]);
  const out = [
    `${ps.length} proposal${ps.length === 1 ? '' : 's'}${header ? ` — ${header}` : ''}:`,
  ];

  for (const p of ps) {
    out.push(
      `[${p.id}] ${p.summary}`,
      ...p.effects.map((e) => `  ${effectLine(e)}`),
    );

    const line = attrLine(own, p);

    if (line) {
      out.push(`  ${line}`);
    }

    if (p.data !== undefined) {
      out.push(...entry('data', p.data, 1));
    }
  }

  return out;
}

function briefLines(r: Brief): string[] {
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

function clarifyLines(r: Clarify): string[] {
  return [
    `? ${r.question}`,
    ...r.options.map((o, i) => `  ${i + 1}. ${o.label}`),
  ];
}

function receiptLines(r: ReceiptReply): string[] {
  const rc = r.receipt;
  const tag = `(receipt ${rc.id})${r.replay ? ' (replay)' : ''}`;
  const out = rc.undoes
    ? [`↶ undid ${rc.undoes}: ${rc.summary} ${tag}`]
    : [
        `✓ ${rc.summary} ${tag} · ${rc.undo ? `undo until ${fmtTime(rc.undo.until)}` : 'irreversible'}`,
      ];

  // The model already saw the effects in the proposal, unless the service auto-committed.
  if (r.auto) {
    out.push(...rc.effects.map((e) => `  ${effectLine(e)}`));
  }

  if (rc.result !== undefined) {
    out.push(...entry('result', rc.result, 1));
  }

  return out;
}

function errorLines(r: ErrorReply): string[] {
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

function eventLine(r: Event): string {
  const progress =
    typeof r.progress === 'number' ? ` (${Math.round(r.progress * 100)}%)` : '';

  return `… ${r.message}${progress}`;
}

function bodyLines(r: Reply): string[] {
  switch (r.kind) {
    case 'BRIEF':
      return briefLines(r);
    case 'ANSWER':
      return [lean(r.data)];
    case 'PROPOSALS':
      return proposalsLines(r.proposals);
    case 'CLARIFY':
      return clarifyLines(r);
    case 'RECEIPT':
      return receiptLines(r);
    case 'ERROR':
      return errorLines(r);
    case 'EVENT':
      return [eventLine(r)];
    default:
      return []; // a frame of unknown kind (untyped caller) renders only its `more` lines
  }
}

/** Render a reply frame as Lens (SPEC §9.2). */
export function lens(r: Reply): string {
  const out = bodyLines(r);

  if ('more' in r) {
    out.push(...moreLines(r.more));
  }

  return out.join('\n');
}

/**
 * Shared token estimate (SPEC §8): count of letter runs, 1–3 digit groups, indentation runs
 * and other non-space characters. Tracks real BPE tokenizers closely on Lens text (mean
 * ratio ≈1.0 vs o200k), and every implementation computes exactly the same number.
 */
const TOKENISH = /[A-Za-z]+|[0-9]{1,3}|\n {2,}|[^ \t\n\r\f\vA-Za-z0-9]/gu;

export const est = (text: string) => text.match(TOKENISH)?.length ?? 0;

/**
 * `v` with every string (and key) made one line by `printable`. For showing a service's fields
 * without letting a summary forge a line.
 */
export function oneLine(v: unknown): unknown {
  if (typeof v === 'string') {
    return printable(v);
  }

  if (Array.isArray(v)) {
    return v.map(oneLine);
  }

  if (typeof v !== 'object' || v === null) {
    return v;
  }

  return Object.fromEntries(
    Object.entries(v).map(([k, x]) => [printable(k), oneLine(x)]),
  );
}

/**
 * `safe` (`orig` after `oneLine`) with `keys` put back from `orig`, and each of its `effects`'
 * `from` and `to`: values Lens quotes itself, which `printable` first would only escape twice.
 */
function keepQuoted(orig: unknown, safe: unknown, keys: string[]): unknown {
  if (!isObject(orig) || !isObject(safe)) {
    return safe;
  }

  const out: Record<string, unknown> = { ...safe };

  for (const k of keys) {
    if (Object.hasOwn(orig, k)) {
      out[k] = orig[k];
    }
  }

  const effects = orig.effects;

  if (Array.isArray(effects) && Array.isArray(safe.effects)) {
    out.effects = safe.effects.map((e, i) =>
      keepQuoted(effects[i], e, ['from', 'to']),
    );
  }

  return out;
}

/**
 * An effect line for a person or a model: its fields made one line by `oneLine`, except `from`
 * and `to`, which Lens quotes itself; then the whole line through `printable`, for what the
 * quotes leave.
 */
export const safeEffectLine = (e: Effect) =>
  printable(effectLine(keepQuoted(e, oneLine(e), ['from', 'to']) as Effect));

/**
 * `safe` (`r` after `oneLine`) with the values Lens renders quoted put back: an ANSWER's
 * `data`, a proposal's `data` and a receipt's `result` (lean, SPEC §9.1), and effects' `from`
 * and `to` (scalars). Only where Lens renders them: a `data` key elsewhere, such as a
 * capability's param, is shown bare and stays escaped.
 */
function quotedBack(r: Reply, safe: unknown): unknown {
  if (!isObject(safe)) {
    return safe;
  }

  switch (r.kind) {
    case 'ANSWER':
      return keepQuoted(r, safe, ['data']);
    case 'PROPOSALS':
      return {
        ...safe,
        proposals: Array.isArray(safe.proposals)
          ? safe.proposals.map((p, i) =>
              keepQuoted(r.proposals[i], p, ['data']),
            )
          : safe.proposals,
      };
    case 'RECEIPT':
      return {
        ...safe,
        receipt: keepQuoted(r.receipt, safe.receipt, ['result']),
      };
    default:
      return safe;
  }
}

/**
 * A service's reply as Lens, for a model or a person: re-rendered from its fields after
 * `oneLine`, never the service's own `lens`, so every line break is ours. Quoted values escape
 * only C0, so each line then goes through `printable`, for the C1, bidi, line-separator and
 * invisible characters left inside quotes. `printable` leaves backslashes alone, so text
 * already escaped isn't escaped again.
 */
export function untrustedLens(reply: Reply): string {
  const { lens: _ignored, ...rest } = reply;

  return lens(quotedBack(reply, oneLine(rest)) as Reply)
    .split('\n')
    .map(printable)
    .join('\n');
}
