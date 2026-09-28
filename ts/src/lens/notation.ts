/**
 * Lean notation (SPEC §9.1): any JSON value as compact, indented text, with
 * scalars bare where that's unambiguous and quoted otherwise.
 */
import { quote } from '../canonical.js';
import { isObject } from '../util.js';

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

export function entry(key: string, v: unknown, n: number): string[] {
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
