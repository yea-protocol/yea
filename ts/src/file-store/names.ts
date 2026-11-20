/**
 * The names a FileStore's paths are made of (SPEC-approval §8): ids and measure names as they
 * are, and a ledger period as its length and start. Anything that couldn't be one is refused,
 * so no path leaves the store.
 */
import type { Period } from '../grants.js';
import { isSafeInt } from '../util.js';

/** Names are b64url ids, receipt ids or measure names; anything else is refused. */
export function safeName(s: string): string {
  if (!/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$/.test(s)) {
    throw new Error(`refusing an unsafe store name: ${JSON.stringify(s)}`);
  }

  return s;
}

/** A period's length and start as store names: safe integers, the length positive, or refused. */
export function periodNames({ every, start }: Period): [string, string] {
  if (!(isSafeInt(every) && every > 0 && isSafeInt(start))) {
    throw new Error(
      `refusing a ledger period of ${every} seconds from ${start}`,
    );
  }

  return [String(every), String(start)];
}
