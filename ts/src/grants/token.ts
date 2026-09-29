/** The grant token (SPEC §6.1, §6.2): caveat and block shapes, the pg1. encoding, block ids and inspection. */
import { b64u, fromUtf8, isB64u, unb64u, utf8 } from '../b64.js';
import { canonical } from '../canonical.js';
import { sha256 } from '../crypto.js';
import type { Risk, Verb } from '../types.js';
import type { Limit } from '../uses.js';
import { isObject } from '../util.js';
import { hasNonMinimalNumber } from './json-integers.js';

export type Caveat =
  | { svc: string[] }
  | { verbs: Verb[] }
  | { can: string[] }
  | { exp: number }
  | { nbf: number }
  | { each: Limit }
  | { total: Limit }
  | { risk: Risk }
  | { only: string };

export interface Block {
  p: Record<string, unknown> & { sub: string; caveats: Caveat[]; iat: number };
  s: string;
}

const GRANT_PREFIX = 'pg1.';

/** The string fields a block's payload needs (SPEC §6.2): the root's, then a delegation's. */
const ROOT_FIELDS = ['iss', 'sub', 'nonce'];
const DELEGATION_FIELDS = ['prev', 'sub'];

/**
 * Whether `b` has the fields and types of block `i` (SPEC §6.2). Keys, signatures and the
 * canonical form are checked when the grant is verified.
 */
function isBlock(b: unknown, i: number): b is Block {
  if (!isObject(b) || !isObject(b.p) || !isB64u(b.s, 64)) {
    return false;
  }

  const p = b.p;
  const fields = i === 0 ? ROOT_FIELDS : DELEGATION_FIELDS;

  return (
    fields.every((k) => typeof p[k] === 'string') &&
    Array.isArray(p.caveats) &&
    Number.isInteger(p.iat)
  );
}

export function encodeGrant(blocks: Block[]): string {
  return GRANT_PREFIX + b64u(utf8(canonical(blocks)));
}

export function decodeGrant(token: string): Block[] {
  if (typeof token !== 'string' || !token.startsWith(GRANT_PREFIX)) {
    throw new Error('not a pg1 grant');
  }

  // Language-neutral: every implementation reports the same text (SPEC-approval reasons).
  let text: string;
  let blocks: unknown;

  try {
    text = fromUtf8(unb64u(token.slice(GRANT_PREFIX.length)));
    blocks = JSON.parse(text);
  } catch {
    throw new Error('not valid b64url JSON');
  }

  if (hasNonMinimalNumber(text)) {
    throw new Error('a number is not an integer in minimal form');
  }

  if (!Array.isArray(blocks) || blocks.length === 0) {
    throw new Error('grant has no blocks');
  }

  if (!blocks.every(isBlock)) {
    throw new Error('malformed block');
  }

  return blocks;
}

export const blockId = (b: Block) => sha256(b.s);

/** An Ed25519 public key as YEA writes it (SPEC §6.1): 32 bytes in canonical base64url. */
export const isPublicKey = (v: unknown): v is string =>
  typeof v === 'string' && v.startsWith('ed25519:') && isB64u(v.slice(8), 32);

export interface GrantInfo {
  id: string;
  iss: string;
  holder: string;
  blocks: { id: string; sub: string; caveats: Caveat[]; iat: number }[];
}

export async function inspectGrant(token: string): Promise<GrantInfo> {
  const blocks = decodeGrant(token);
  const ids = await Promise.all(blocks.map(blockId));

  return {
    id: ids[0],
    iss: blocks[0].p.iss as string,
    holder: blocks[blocks.length - 1].p.sub,
    blocks: blocks.map((b, i) => ({
      id: ids[i],
      sub: b.p.sub,
      caveats: b.p.caveats,
      iat: b.p.iat,
    })),
  };
}
