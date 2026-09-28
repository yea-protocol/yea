/**
 * Ed25519 keys, signatures, hashes and random ids over WebCrypto: the
 * primitives grants, proofs and consents are built from (SPEC §6).
 */
import { b64u, unb64u, utf8 } from './b64.js';
import { canonical } from './canonical.js';

/** An Ed25519 identity. `seed` is the 32-byte private seed (b64url); `public` is "ed25519:<b64url>". */
export interface KeyPair {
  seed: string;
  public: string;
}

const subtle = globalThis.crypto.subtle;
const PKCS8_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04,
  0x22, 0x04, 0x20,
]);
const privCache = new Map<string, CryptoKey>();

async function privateKey(seed: string): Promise<CryptoKey> {
  let k = privCache.get(seed);

  if (!k) {
    const raw = unb64u(seed);

    if (raw.length !== 32) {
      throw new Error('Ed25519 seed must be 32 bytes');
    }

    const pkcs8 = new Uint8Array(48);

    pkcs8.set(PKCS8_PREFIX);
    pkcs8.set(raw, 16);
    k = await subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, true, [
      'sign',
    ]);
    privCache.set(seed, k);
  }

  return k;
}

/** Derive a key pair from a seed, or generate a fresh one. */
export async function keyPair(seed?: string): Promise<KeyPair> {
  seed ??= b64u(globalThis.crypto.getRandomValues(new Uint8Array(32)));

  const jwk = await subtle.exportKey('jwk', await privateKey(seed));

  return { seed, public: `ed25519:${jwk.x}` };
}

export async function sign(seed: string, message: string): Promise<string> {
  const sig = await subtle.sign(
    { name: 'Ed25519' },
    await privateKey(seed),
    utf8(message),
  );

  return b64u(new Uint8Array(sig));
}

export async function verify(
  publicKey: string,
  message: string,
  sig: string,
): Promise<boolean> {
  try {
    if (!publicKey.startsWith('ed25519:')) {
      return false;
    }

    const raw = unb64u(publicKey.slice(8));

    if (raw.length !== 32) {
      return false;
    }

    const key = await subtle.importKey('raw', raw, { name: 'Ed25519' }, false, [
      'verify',
    ]);

    return await subtle.verify(
      { name: 'Ed25519' },
      key,
      unb64u(sig),
      utf8(message),
    );
  } catch {
    return false;
  }
}

export async function sha256(s: string): Promise<string> {
  return b64u(new Uint8Array(await subtle.digest('SHA-256', utf8(s))));
}

/** Hash of a proposal (SPEC §5.1): sha256 over canonical JSON without `hash` and `data`. */
export async function proposalHash(p: object): Promise<string> {
  const { hash: _h, data: _d, ...rest } = p as Record<string, unknown>;

  return sha256(canonical(rest));
}

export function randomId(prefix: string, bytes = 9): string {
  return (
    prefix +
    '_' +
    b64u(globalThis.crypto.getRandomValues(new Uint8Array(bytes)))
  );
}
