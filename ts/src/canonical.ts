/**
 * Canonical JSON (SPEC §10): sorted keys, no whitespace, integers only.
 * Used for everything that is hashed or signed.
 */
export function canonical(v: unknown): string {
  if (v === null) {
    return 'null';
  }

  switch (typeof v) {
    case 'boolean':
      return v ? 'true' : 'false';
    case 'number':
      if (!Number.isSafeInteger(v)) {
        throw new TypeError(
          `canonical JSON allows only safe integers, got ${v}`,
        );
      }

      return String(v);
    case 'string':
      return quote(v);
    case 'object': {
      if (Array.isArray(v)) {
        return `[${v.map(canonical).join(',')}]`;
      }

      const obj = v as Record<string, unknown>;
      const keys = Object.keys(obj)
        .filter((k) => obj[k] !== undefined)
        .sort(byCodePoint);

      return (
        '{' +
        keys.map((k) => `${quote(k)}:${canonical(obj[k])}`).join(',') +
        '}'
      );
    }
    default:
      throw new TypeError(`cannot canonicalize ${typeof v}`);
  }
}

/** Orders strings by Unicode code point (SPEC §10), not by UTF-16 unit as `<` does. */
export function byCodePoint(a: string, b: string): number {
  const A = codePoints(a);
  const B = codePoints(b);

  for (let i = 0; i < Math.min(A.length, B.length); i++) {
    const d = A[i] - B[i];

    if (d !== 0) {
      return d;
    }
  }

  return A.length - B.length;
}

/** Spreading a string yields whole code points, so `codePointAt(0)` is always defined. */
const codePoints = (s: string): number[] =>
  [...s].map((c) => c.codePointAt(0) ?? 0);

const ESC: Record<string, string> = {
  '"': '\\"',
  '\\': '\\\\',
  '\b': '\\b',
  '\f': '\\f',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
};

/** JSON string literal: short escapes where JSON has them, `\u00XX` for other control characters. */
export function quote(s: string): string {
  let out = '"';

  for (const c of s) {
    out += ESC[c] ?? (c < ' ' ? unicodeEscape(c) : c);
  }

  return `${out}"`;
}

const unicodeEscape = (c: string): string =>
  `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`;
