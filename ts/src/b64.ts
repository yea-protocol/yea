/**
 * Byte and text encodings: base64url without padding (RFC 4648 §5), and
 * UTF-8 to and from bytes.
 */

/** base64url without padding (RFC 4648 §5). */
export function b64u(bytes: Uint8Array): string {
  let bin = '';

  for (const b of bytes) {
    bin += String.fromCharCode(b);
  }

  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const ALPHABET = /^[A-Za-z0-9_-]*$/;

/**
 * Decode canonical base64url (SPEC §6.1): the alphabet only, no padding, and the unused
 * bits of the last character zero, so every byte string has exactly one encoding. Anything
 * else throws.
 */
export function unb64u(s: string): Uint8Array<ArrayBuffer> {
  if (!ALPHABET.test(s) || s.length % 4 === 1) {
    throw new Error('invalid base64url');
  }

  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);

  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }

  if (b64u(out) !== s) {
    throw new Error('non-canonical base64url');
  }

  return out;
}

/** Whether `s` is canonical base64url (see `unb64u`), of exactly `bytes` bytes if given. */
export function isB64u(s: unknown, bytes?: number): s is string {
  if (typeof s !== 'string') {
    return false;
  }

  try {
    const raw = unb64u(s);

    return bytes === undefined || raw.length === bytes;
  } catch {
    return false;
  }
}

export const utf8 = (s: string): Uint8Array<ArrayBuffer> =>
  new TextEncoder().encode(s) as Uint8Array<ArrayBuffer>;

export const fromUtf8 = (b: Uint8Array) => new TextDecoder().decode(b);
