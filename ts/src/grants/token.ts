/** The grant token (SPEC §6.1, §6.2): caveat and block shapes, the pg1. encoding, block ids and inspection. */
import { b64u, fromUtf8, unb64u, utf8 } from '../b64.js';
import { canonical } from '../canonical.js';
import { sha256 } from '../crypto.js';
import type { Risk, Verb } from '../types.js';
import type { Limit } from '../uses.js';

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

export function encodeGrant(blocks: Block[]): string {
  return GRANT_PREFIX + b64u(utf8(canonical(blocks)));
}

export function decodeGrant(token: string): Block[] {
  if (!token.startsWith(GRANT_PREFIX)) {
    throw new Error('not a pg1 grant');
  }

  // Language-neutral: every implementation reports the same text (SPEC-approval reasons).
  let blocks: unknown;

  try {
    blocks = JSON.parse(fromUtf8(unb64u(token.slice(GRANT_PREFIX.length))));
  } catch {
    throw new Error('not valid b64url JSON');
  }

  if (!Array.isArray(blocks) || blocks.length === 0) {
    throw new Error('grant has no blocks');
  }

  for (const b of blocks as Partial<Block>[]) {
    if (
      typeof b?.s !== 'string' ||
      typeof b?.p?.sub !== 'string' ||
      !Array.isArray(b?.p?.caveats)
    ) {
      throw new Error('malformed block');
    }
  }

  return blocks as Block[];
}

export const blockId = (b: Block) => sha256(b.s);

/** An Ed25519 public key as YEA writes it (SPEC §6.1). */
export const isPublicKey = (v: unknown): v is string =>
  typeof v === 'string' && /^ed25519:[A-Za-z0-9_-]{43}$/.test(v);

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
