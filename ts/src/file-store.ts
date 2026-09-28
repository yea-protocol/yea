/**
 * The approval store on disk (docs/framework/SPEC-approval.md §8), shared by TypeScript and
 * Python servers and the `yea` command, and the check on the pinned principal key (§2).
 * Node only; exported from `@yea-protocol/sdk/node`. The file operations, the lock and the key
 * check live in file-store/; this file holds the store.
 */
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomId, sha256 } from './crypto.js';
import {
  breakIfStale,
  createOnce,
  readOrNull,
  writeAtomic,
} from './file-store/files.js';
import { acquire } from './file-store/lock.js';
import { home } from './home.js';
import type {
  ApprovalStore,
  JobReceipt,
  LedgerKey,
  Reservation,
} from './store.js';

export { checkKeyFile, readPinnedKey } from './file-store/pinned-key.js';

/** An undo claimed but never finished (the process died) can be claimed again after this. */
const STALE_CLAIM_MS = 600_000;

interface LedgerFile {
  settled: string;
  reserved: Record<string, string>;
}

const ledgerTotal = (l: LedgerFile) =>
  Object.values(l.reserved).reduce((a, b) => a + BigInt(b), BigInt(l.settled));

export class FileStore implements ApprovalStore {
  readonly root: string;

  constructor(root = join(home(), 'store')) {
    this.root = root;
  }

  async consumeOnce(id: string, expiresAt: number): Promise<boolean> {
    return createOnce(
      join(this.root, 'consumed', await sha256(id)),
      String(expiresAt),
    );
  }

  async putReceipt(r: JobReceipt): Promise<void> {
    writeAtomic(this.receiptPath(r.id), JSON.stringify(r));
  }

  async getReceipt(id: string): Promise<JobReceipt | null> {
    const text = readOrNull(this.receiptPath(id));

    return text === null ? null : (JSON.parse(text) as JobReceipt);
  }

  async claimUndo(id: string): Promise<boolean> {
    if (readOrNull(this.undoPath(id, 'done')) !== null) {
      return false;
    }

    const claim = this.undoPath(id, 'claim');

    // Each claim holds a fresh token, so a stale one is only ever broken by its own contents.
    if (createOnce(claim, randomId('k'))) {
      return true;
    }

    breakIfStale(claim, STALE_CLAIM_MS);

    return createOnce(claim, randomId('k'));
  }

  async releaseUndo(id: string): Promise<void> {
    rmSync(this.undoPath(id, 'claim'), { force: true });
  }

  async markUndone(id: string): Promise<void> {
    createOnce(this.undoPath(id, 'done'));
  }

  async reserve(
    key: LedgerKey,
    amount: bigint,
    max: bigint,
  ): Promise<Reservation | null> {
    return await this.withLedger(key, (l) => {
      if (ledgerTotal(l) + amount > max) {
        return null;
      }

      const id = randomId('v');

      l.reserved[id] = String(amount);

      return { id, key, amount };
    });
  }

  async settle(r: Reservation): Promise<void> {
    await this.withLedger(r.key, (l) => {
      if (Object.hasOwn(l.reserved, r.id)) {
        delete l.reserved[r.id];
        l.settled = String(BigInt(l.settled) + r.amount);
      }
    });
  }

  async release(r: Reservation): Promise<void> {
    await this.withLedger(r.key, (l) => {
      delete l.reserved[r.id];
    });
  }

  async used(key: LedgerKey): Promise<bigint> {
    return ledgerTotal(this.readLedger(key));
  }

  async putConsent(planHash: string, grant: string): Promise<void> {
    writeAtomic(this.consentPath(planHash), grant);
  }

  async getConsent(planHash: string): Promise<string | null> {
    return readOrNull(this.consentPath(planHash));
  }

  // ---- paths: every name from outside is checked or hashed before it reaches one ----

  private receiptPath(id: string) {
    return join(this.root, 'receipts', `${safeName(id)}.json`);
  }

  private undoPath(id: string, which: 'claim' | 'done') {
    return join(this.root, 'undo', `${safeName(id)}.${which}`);
  }

  private consentPath(planHash: string) {
    return join(this.root, 'consents', safeName(planHash));
  }

  private ledgerPath(key: LedgerKey, ext: 'json' | 'lock') {
    return join(
      this.root,
      'ledger',
      safeName(key.block),
      `${safeName(key.of)}.${ext}`,
    );
  }

  private readLedger(key: LedgerKey): LedgerFile {
    const text = readOrNull(this.ledgerPath(key, 'json'));

    return text === null
      ? { settled: '0', reserved: {} }
      : (JSON.parse(text) as LedgerFile);
  }

  /** Read, change and write one ledger file under its lock file. */
  private async withLedger<T>(
    key: LedgerKey,
    change: (l: LedgerFile) => T,
  ): Promise<T> {
    const lock = this.ledgerPath(key, 'lock');
    const token = await acquire(lock);

    try {
      const l = this.readLedger(key);
      const out = change(l);

      if (readOrNull(lock) !== token) {
        throw new Error(
          `lost the approval store lock (${lock}); nothing was written`,
        );
      }

      writeAtomic(this.ledgerPath(key, 'json'), JSON.stringify(l));

      // A lock broken as stale between the check and the write (a holder paused > 30 s) may
      // have let another write through; refuse rather than report success (SPEC-approval §8).
      if (readOrNull(lock) !== token) {
        throw new Error(`lost the approval store lock while writing (${lock})`);
      }

      return out;
    } finally {
      if (readOrNull(lock) === token) {
        rmSync(lock, { force: true });
      }
    }
  }
}

/**
 * The store the MCP servers and the `yea` command share: `YEA_STORE` if set, else
 * `~/.yea/store`. An empty `YEA_STORE` counts as unset.
 */
export const defaultFileStore = () =>
  new FileStore(process.env.YEA_STORE || undefined);

/** Names are b64url ids, receipt ids or measure names; anything else is refused. */
function safeName(s: string): string {
  if (!/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$/.test(s)) {
    throw new Error(`refusing an unsafe store name: ${JSON.stringify(s)}`);
  }

  return s;
}
