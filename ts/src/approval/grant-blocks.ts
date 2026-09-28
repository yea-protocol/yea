/** Reading a policy or consent grant's blocks and caveats before the grant check runs. */
import { blockId, decodeGrant } from '../grants.js';

/** A grant's blocks with their ids, or null if it can't be decoded (the grant check says why). */
export async function blocksOf(
  grant: string,
): Promise<{ id: string; caveats: unknown[] }[] | null> {
  try {
    return await Promise.all(
      decodeGrant(grant).map(async (b) => ({
        id: await blockId(b),
        caveats: b.p.caveats,
      })),
    );
  } catch {
    return null;
  }
}

export const caveatOf = (c: unknown, k: string): unknown =>
  c && typeof c === 'object' && Object.hasOwn(c, k)
    ? (c as Record<string, unknown>)[k]
    : undefined;
