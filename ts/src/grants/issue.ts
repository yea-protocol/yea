/** Signing grants (SPEC §6.2): a principal issues a root block, and a holder delegates a narrower one. */
import { b64u } from '../b64.js';
import { canonical } from '../canonical.js';
import { type KeyPair, keyPair, sign } from '../crypto.js';
import { unixNow } from '../util.js';
import { blockId, type Caveat, decodeGrant, encodeGrant } from './token.js';

/** Issue a root grant from `principal` to the key `to`. */
export async function issueGrant(opts: {
  principal: KeyPair | string;
  to: string;
  caveats?: Caveat[];
  iat?: number;
  nonce?: string;
}): Promise<string> {
  const principal =
    typeof opts.principal === 'string'
      ? await keyPair(opts.principal)
      : opts.principal;
  const p = {
    iss: principal.public,
    sub: opts.to,
    caveats: opts.caveats ?? [],
    iat: opts.iat ?? unixNow(),
    nonce:
      opts.nonce ?? b64u(globalThis.crypto.getRandomValues(new Uint8Array(12))),
  };

  return encodeGrant([{ p, s: await sign(principal.seed, canonical(p)) }]);
}

/** Attenuate: the current holder (by seed) delegates a narrower grant to `to`. */
export async function delegateGrant(
  token: string,
  opts: {
    holder: KeyPair | string;
    to: string;
    caveats?: Caveat[];
    iat?: number;
  },
): Promise<string> {
  const blocks = decodeGrant(token);
  const holder =
    typeof opts.holder === 'string' ? await keyPair(opts.holder) : opts.holder;
  const last = blocks[blocks.length - 1];

  if (last.p.sub !== holder.public) {
    throw new Error('only the current holder can delegate this grant');
  }

  const p = {
    prev: await blockId(last),
    sub: opts.to,
    caveats: opts.caveats ?? [],
    iat: opts.iat ?? unixNow(),
  };

  return encodeGrant([
    ...blocks,
    { p, s: await sign(holder.seed, canonical(p)) },
  ]);
}
