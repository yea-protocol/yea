/**
 * The pending files a job call writes and removes (docs/framework/SPEC-approval.md §6, Short ids):
 * each consent code goes in the store's `pending/` under a short id, so the person types
 * `yea approve <id>`; a plan that runs takes its files with it. A store that isn't a FileStore
 * gets no files, and a file that can't be written costs the ids, never the codes.
 */
import { pendingCodesOf } from '@yea-protocol/sdk/node';
import { errorMessage, warnOnce } from '../util.js';
import type { Call } from './context.js';

/** A consent code as a result names it: with its short id, once its pending file is written. */
export interface Code {
  planHash: string;
  code: string;
  id?: string;
}

/** The codes with their ids, or as they are if there is nowhere to write or a write fails. */
export function withIds(
  call: Call,
  codes: { planHash: string; code: string }[],
): Code[] {
  const pending = pendingCodesOf(call.y.store);

  if (!pending || !codes.length) {
    return codes;
  }

  try {
    return codes.map((c) => ({ ...c, id: pending.put(c.code, call.now) }));
  } catch (e) {
    warnOnce(`can't write a pending file, so no short ids: ${errorMessage(e)}`);

    return codes;
  }
}

/** A plan that runs needs no approval any more: remove its pending files. */
export function dropPending(call: Call, planHash: string) {
  try {
    pendingCodesOf(call.y.store)?.drop(call.policy.server, planHash);
  } catch (e) {
    warnOnce(`can't remove a pending file: ${errorMessage(e)}`);
  }
}
