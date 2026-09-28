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

export function unb64u(s: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) {
    throw new Error('invalid base64url');
  }

  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);

  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }

  return out;
}

export const utf8 = (s: string): Uint8Array<ArrayBuffer> =>
  new TextEncoder().encode(s) as Uint8Array<ArrayBuffer>;

export const fromUtf8 = (b: Uint8Array) => new TextDecoder().decode(b);
