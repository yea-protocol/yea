/**
 * The approval store on disk (docs/framework/SPEC-approval.md §8), shared by TypeScript and
 * Python servers and the `yea` command, and the check on the pinned principal key (§2).
 * Node only; exported from `@yea-protocol/sdk/node`.
 */
import {
  accessSync,
  constants,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomId, sha256 } from './crypto.js';
import { home } from './home.js';
import type {
  ApprovalStore,
  JobReceipt,
  LedgerKey,
  Reservation,
} from './store.js';

const LOCK_WAIT_MS = 2000;
const LOCK_RETRY_MS = 10;
const STALE_LOCK_MS = 30_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Create `path` only if it doesn't exist (O_EXCL); false if it did. */
function createOnce(path: string, text = ''): boolean {
  mkdirSync(dirname(path), { recursive: true });

  try {
    writeFileSync(path, text, { flag: 'wx' });

    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
      return false;
    }

    throw e;
  }
}

/** Write via `<name>.tmp` and rename, so a reader never sees half a file. */
function writeAtomic(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });

  const tmp = `${path}.tmp`;

  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }

    throw e;
  }
}

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
    const done = readOrNull(this.undoPath(id, 'done')) !== null;

    return !done && createOnce(this.undoPath(id, 'claim'));
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

    await acquire(lock);

    try {
      const l = this.readLedger(key);
      const out = change(l);

      writeAtomic(this.ledgerPath(key, 'json'), JSON.stringify(l));

      return out;
    } finally {
      rmSync(lock, { force: true });
    }
  }
}

/** Names are b64url ids, receipt ids or measure names; anything else is refused. */
function safeName(s: string): string {
  if (!/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$/.test(s)) {
    throw new Error(`refusing an unsafe store name: ${JSON.stringify(s)}`);
  }

  return s;
}

/** Take a lock file (O_EXCL), retrying for up to 2 s; a lock older than 30 s is stale. */
async function acquire(lock: string) {
  const until = Date.now() + LOCK_WAIT_MS;

  while (!createOnce(lock, String(process.pid))) {
    removeIfStale(lock);

    if (Date.now() > until) {
      throw new Error(`the approval store is busy (${lock})`);
    }

    await sleep(LOCK_RETRY_MS);
  }
}

function removeIfStale(lock: string) {
  try {
    if (Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS) {
      rmSync(lock, { force: true });
    }
  } catch {
    // gone already
  }
}

// ---- the pinned principal key (§2) ----

const uid = () =>
  typeof process.getuid === 'function' ? process.getuid() : -1;

/** Whether this OS user could change `path`: owns it, or can write it. */
function changeable(path: string): boolean {
  if (statSync(path).uid === uid() || lstatSync(path).uid === uid()) {
    return true;
  }

  try {
    accessSync(path, constants.W_OK);

    return true;
  } catch {
    return false;
  }
}

/**
 * Why the principal key file can't be trusted, or null. Neither the file nor any directory
 * above it may be owned or writable by the server's OS user, or the agent could swap the key.
 */
export function checkKeyFile(path: string): string | null {
  let real: string;

  try {
    real = realpathSync(path);
  } catch {
    return `${path} can't be read`;
  }

  // Both the path as given (a symlink's own directory) and where it really leads.
  return unchangeableChain(resolve(path)) ?? unchangeableChain(real);
}

/** Why `path` or a directory above it could be changed by this user, or null. */
function unchangeableChain(path: string): string | null {
  let p = path;

  for (;;) {
    try {
      if (changeable(p)) {
        return `${p} can be changed by this user, so the agent could replace the principal key`;
      }
    } catch {
      return `${p} can't be read`;
    }

    const up = dirname(p);

    if (up === p) {
      return null;
    }

    p = up;
  }
}

/** The pinned principal public key from `YEA_PRINCIPAL_PUB`, or why there isn't a usable one. */
export function readPinnedKey(
  path = process.env.YEA_PRINCIPAL_PUB,
): { key: string } | { why: string } {
  if (!path) {
    return { why: 'YEA_PRINCIPAL_PUB is not set' };
  }

  const why = checkKeyFile(path);

  if (why) {
    return { why };
  }

  const key = readFileSync(path, 'utf8').trim();

  return /^ed25519:[A-Za-z0-9_-]{43}$/.test(key)
    ? { key }
    : { why: `${path} does not hold an ed25519 public key` };
}
