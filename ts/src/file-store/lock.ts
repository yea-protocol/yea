/** The approval store's lock files: taken with O_EXCL, each holding a fresh token, broken when stale. */
import { randomId } from '../crypto.js';
import { breakIfStale, createOnce } from './files.js';

const LOCK_WAIT_MS = 2000;
const LOCK_RETRY_MS = 10;
const STALE_LOCK_MS = 30_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Take a lock file (O_EXCL) holding a fresh token, retrying for up to 2 s; returns the token. */
export async function acquire(lock: string): Promise<string> {
  const token = randomId('k');
  const until = Date.now() + LOCK_WAIT_MS;

  while (!createOnce(lock, token)) {
    breakIfStale(lock, STALE_LOCK_MS);

    if (Date.now() > until) {
      throw new Error(`the approval store is busy (${lock})`);
    }

    await sleep(LOCK_RETRY_MS);
  }

  return token;
}
