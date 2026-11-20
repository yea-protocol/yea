/**
 * The approval store on disk (docs/framework/SPEC-approval.md §8), shared by TypeScript and
 * Python servers and the `yea` command. Node only; exported from `@yea-protocol/sdk/node`. The
 * file operations, the lock and the pending files (§6, Short ids) live in file-store/; this file
 * holds the store.
 */
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomId, sha256 } from './crypto.js';
import {
  breakIfStale,
  createOnce,
  NotRegularFile,
  readOrNull,
  readRegular,
  writeAtomic,
} from './file-store/files.js';
import { acquire, release, stillHeld } from './file-store/lock.js';
import { periodNames, safeName } from './file-store/names.js';
import { PendingCodes } from './file-store/pending.js';
import { ensureStoreId } from './file-store/store-id.js';
import { home } from './home.js';
import type {
  ApprovalStore,
  JobReceipt,
  LedgerKey,
  Reservation,
} from './store.js';
import { errno } from './util.js';

/** An undo claimed but never finished (the process died) can be claimed again after this. */
const STALE_CLAIM_MS = 600_000;

interface LedgerFile {
  settled: string;
  reserved: Record<string, string>;
}

const ledgerTotal = (l: LedgerFile) =>
  Object.values(l.reserved).reduce((a, b) => a + BigInt(b), BigInt(l.settled));

export {
  issuerEnded,
  newPendingId,
  PENDING_ID,
  type PendingCode,
  PendingCodes,
  type PendingConsent,
  type PendingIssuer,
  pendingFile,
} from './file-store/pending.js';

export { readStoreId } from './file-store/store-id.js';

export class FileStore implements ApprovalStore {
  /** The brand `pendingCodesOf` reads, as `isMemoryStore` reads MemoryStore's. */
  readonly yeaStore = 'file' as const;
  readonly root: string;
  private id: string | null = null;

  constructor(root = join(home(), 'store')) {
    this.root = root;
  }

  /** `<root>/id`, made by the first process that needs it, then kept for this instance (§8). */
  async storeId(): Promise<string> {
    this.id ??= await ensureStoreId(this.root);

    return this.id;
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
    if (this.undone(id)) {
      return false;
    }

    const claim = this.undoPath(id, 'claim');

    // Each claim holds a fresh token, so a stale one is only ever broken by its own contents.
    if (!createOnce(claim, randomId('k'))) {
      // A revert that crashed mid-way can be tried again; one that was only slow may have
      // finished (and dropped its claim) meanwhile, so look for `done` again before claiming.
      breakIfStale(claim, STALE_CLAIM_MS);

      if (this.undone(id) || !createOnce(claim, randomId('k'))) {
        return false;
      }
    }

    // An undo can finish between the look for `done` and the claim: then the claim is not ours
    // to use.
    if (this.undone(id)) {
      await this.releaseUndo(id);

      return false;
    }

    return true;
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

  /**
   * The consent stored for a plan, or null. It's read as a server key is (`readRegular`), and one
   * that is there but can't be read that way (a mode or owner that shuts this user out; a symlink,
   * directory, FIFO or device in its place; over 64 KiB) counts as absent, with a line on stderr:
   * it can only mean asking again, never an fs error in the model's context (SPEC-approval §8).
   * Anything else is still thrown.
   */
  async getConsent(planHash: string): Promise<string | null> {
    const path = this.consentPath(planHash);

    try {
      return readRegular(path);
    } catch (e) {
      const why = e instanceof NotRegularFile ? e.message : errno(e);

      if (why === undefined) {
        throw e;
      }

      console.error(
        `yea: the consent at ${path} can't be read (${why}), so it counts as absent`,
      );

      return null;
    }
  }

  // ---- paths: every name from outside is checked or hashed before it reaches one ----

  private receiptPath(id: string) {
    return join(this.root, 'receipts', `${safeName(id)}.json`);
  }

  private undone(id: string): boolean {
    return readOrNull(this.undoPath(id, 'done')) !== null;
  }

  private undoPath(id: string, which: 'claim' | 'done') {
    return join(this.root, 'undo', `${safeName(id)}.${which}`);
  }

  private consentPath(planHash: string) {
    return join(this.root, 'consents', safeName(planHash));
  }

  /** `ledger/<block>/<of>.json`, or for one period, `ledger/<block>/<of>@<every>/<start>.json`. */
  private ledgerPath({ block, of, period }: LedgerKey, ext: 'json' | 'lock') {
    const dir = join(this.root, 'ledger', safeName(block));

    if (!period) {
      return join(dir, `${safeName(of)}.${ext}`);
    }

    const [every, start] = periodNames(period);

    return join(dir, `${safeName(of)}@${every}`, `${start}.${ext}`);
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

      if (!stillHeld(lock, token)) {
        throw new Error(
          `lost the approval store lock (${lock}); nothing was written`,
        );
      }

      writeAtomic(this.ledgerPath(key, 'json'), JSON.stringify(l));

      // A lock broken as stale between the check and the write (a holder paused > 30 s) may
      // have let another write through; refuse rather than report success (SPEC-approval §8).
      if (!stillHeld(lock, token)) {
        throw new Error(`lost the approval store lock while writing (${lock})`);
      }

      return out;
    } finally {
      release(lock, token);
    }
  }
}

/**
 * The store the MCP servers and the `yea` command share: `YEA_STORE` if set, else
 * `$YEA_HOME/store`, else `~/.yea/store`. An empty `YEA_STORE` counts as unset.
 */
export const defaultFileStore = () =>
  new FileStore(process.env.YEA_STORE || undefined);

/** The pending files the bridge writes in the home `dir` (default: `home()`), `<home>/pending`. */
export const homePending = (dir = home()) =>
  new PendingCodes(join(dir, 'pending'));

/**
 * The pending files beside a FileStore's consents (SPEC-approval §6, Short ids), or null for
 * any other store. By its brand rather than `instanceof`, so a second copy of the SDK still
 * counts.
 */
export function pendingCodesOf(s: unknown): PendingCodes | null {
  const f = s as { yeaStore?: unknown; root?: unknown } | null;

  return f?.yeaStore === 'file' && typeof f.root === 'string'
    ? new PendingCodes(join(f.root, 'pending'))
    : null;
}
