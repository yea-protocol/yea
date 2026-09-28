/**
 * Request proofs (SPEC §6.5): the holder key signs the audience, verb, target and time, so a
 * grant is only usable by its holder and only for the request it was sent with.
 */
import { canonical } from './canonical.js';
import { keyPair, sign, verify } from './crypto.js';
import type { Proof, Verb } from './types.js';
import { unixNow } from './util.js';

export interface ProofTarget {
  aud: string;
  verb: Verb;
  target: string;
}

export async function makeProof(
  seed: string,
  t: ProofTarget,
  ts = unixNow(),
): Promise<Proof> {
  const kp = await keyPair(seed);

  return {
    key: kp.public,
    ts,
    sig: await sign(
      seed,
      canonical({ aud: t.aud, verb: t.verb, target: t.target, ts }),
    ),
  };
}

export async function checkProof(
  proof: Proof | undefined,
  t: ProofTarget,
  at = unixNow(),
): Promise<string | null> {
  if (
    !proof ||
    typeof proof.key !== 'string' ||
    typeof proof.sig !== 'string' ||
    !Number.isSafeInteger(proof.ts)
  ) {
    return 'missing or malformed proof';
  }

  if (Math.abs(at - proof.ts) > 300) {
    return 'proof timestamp is outside the 300s window';
  }

  const ok = await verify(
    proof.key,
    canonical({ aud: t.aud, verb: t.verb, target: t.target, ts: proof.ts }),
    proof.sig,
  );

  return ok ? null : 'proof signature is invalid';
}
