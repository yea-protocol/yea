/**
 * Canonical JSON (SPEC §10), the byte form of everything YEA hashes or signs,
 * and the code-point string order and quoting it is built on.
 */

/**
 * Canonical JSON (SPEC §10): sorted keys, no whitespace, integers only, and
 * no lone surrogates. Used for everything that is hashed or signed.
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
      return canonicalString(v);
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
        keys
          .map((k) => `${canonicalString(k)}:${canonical(obj[k])}`)
          .join(',') +
        '}'
      );
    }
    default:
      throw new TypeError(`cannot canonicalize ${typeof v}`);
  }
}

/** A lone surrogate: in `u` mode a paired surrogate is one code point and doesn't match. */
const LONE_SURROGATE = /\p{Surrogate}/u;

/**
 * A string (or key) as canonical JSON. A lone surrogate has no UTF-8 encoding, so the bytes
 * would depend on how the encoder replaces it: SPEC §10 refuses it.
 */
function canonicalString(s: string): string {
  if (LONE_SURROGATE.test(s)) {
    throw new TypeError('canonical JSON refuses strings with a lone surrogate');
  }

  return quote(s);
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

/**
 * JSON string literal: short escapes where JSON has them, `\uXXXX` for other control characters
 * and for lone surrogates (as well-formed `JSON.stringify` does; Lens quotes with this).
 */
export function quote(s: string): string {
  let out = '"';

  for (const c of s) {
    out += ESC[c] ?? (c < ' ' || isLoneSurrogate(c) ? unicodeEscape(c) : c);
  }

  return `${out}"`;
}

/** Iterating a string by code point leaves a lone surrogate as a one-unit string. */
const isLoneSurrogate = (c: string): boolean =>
  c.length === 1 && c >= '\ud800' && c <= '\udfff';

const unicodeEscape = (c: string): string =>
  `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`;
