/** Verifying a grant token against a request (SPEC §6.4): decode, chain, trust, holder, then caveats. */
import { canonical } from '../canonical.js';
import { verify } from '../crypto.js';
import type { CheckContext, GrantCheck } from './context.js';
import { evaluateCaveats } from './evaluate.js';
import { type Block, blockId, decodeGrant, isPublicKey } from './token.js';

/** Verify a grant token against a request (SPEC §6.4). Never throws. */
export async function checkGrant(
  token: string,
  ctx: CheckContext,
): Promise<GrantCheck> {
  try {
    return await checkGrantUnsafe(token, ctx);
  } catch (e) {
    return {
      ok: false,
      code: 'forbidden',
      reason: `malformed grant content: ${(e as Error).message}`,
    };
  }
}

type GrantFailure = Extract<GrantCheck, { ok: false }>;

const unauthorized = (reason: string, iss?: string): GrantFailure => ({
  ok: false,
  code: 'unauthorized',
  reason,
  ...(iss === undefined ? {} : { iss }),
});

/**
 * The bytes block `i` signs, or why it is malformed (SPEC §6.2): its `sub` is not a public key,
 * or its payload has no canonical form (a non-integer number, a lone surrogate).
 */
function signedBytes(b: Block, i: number): string | GrantFailure {
  if (!isPublicKey(b.p.sub)) {
    return unauthorized(`malformed grant: block ${i} sub is not a public key`);
  }

  try {
    return canonical(b.p);
  } catch (e) {
    return unauthorized(`malformed grant: ${(e as Error).message}`);
  }
}

/** Check each block is chained to the previous one and signed by its holder; yields the final holder. */
async function verifyChain(
  blocks: Block[],
  iss: string,
): Promise<{ ok: true; holder: string } | GrantFailure> {
  let signer = iss;

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];

    if (i > 0 && b.p.prev !== (await blockId(blocks[i - 1]))) {
      return unauthorized(`block ${i} is not chained to block ${i - 1}`);
    }

    const bytes = signedBytes(b, i);

    if (typeof bytes !== 'string') {
      return bytes;
    }

    if (!(await verify(signer, bytes, b.s))) {
      return unauthorized(`bad signature on block ${i}`);
    }

    signer = b.p.sub;
  }

  return { ok: true, holder: signer };
}

async function checkGrantUnsafe(
  token: string,
  ctx: CheckContext,
): Promise<GrantCheck> {
  let blocks: Block[];

  try {
    blocks = decodeGrant(token);
  } catch (e) {
    return unauthorized(`malformed grant: ${(e as Error).message}`);
  }

  // decodeGrant has checked that the root names its issuer.
  const iss = blocks[0].p.iss as string;
  const chain = await verifyChain(blocks, iss);

  if (!chain.ok) {
    return chain;
  }

  const trusted =
    typeof ctx.trusted === 'function'
      ? ctx.trusted(iss)
      : ctx.trusted.includes(iss);

  if (!trusted) {
    return unauthorized(
      'grant is issued by a principal this service does not trust',
      iss,
    );
  }

  if (chain.holder !== ctx.proofKey) {
    return unauthorized('proof key is not the grant holder', iss);
  }

  const { hard, soft, totals } = await evaluateCaveats(blocks, ctx);

  if (hard.length) {
    return {
      ok: false,
      code: 'forbidden',
      reason: hard.map((h) => h.why).join('; '),
      iss,
      need: hard.map((h) => h.c),
    };
  }

  if (soft.length) {
    return {
      ok: false,
      code: 'consent_required',
      reason: soft.map((h) => h.why).join('; '),
      iss,
    };
  }

  return {
    ok: true,
    id: await blockId(blocks[0]),
    iss,
    holder: chain.holder,
    totals,
  };
}
