/**
 * The approval store on disk (docs/framework/SPEC-approval.md §8), shared by TypeScript and
 * Python servers and the `yea` command, and the check on the pinned principal key (§2).
 * Node only; exported from `@yea-protocol/sdk/node`.
 */
import {
  accessSync,
  constants,
  linkSync,
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
/** An undo claimed but never finished (the process died) can be claimed again after this. */
const STALE_CLAIM_MS = 600_000;
const PRIVATE = 0o700;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const mkdirFor = (path: string) =>
  mkdirSync(dirname(path), { recursive: true, mode: PRIVATE });

/** Create `path` only if it doesn't exist (O_EXCL); false if it did. */
function createOnce(path: string, text = ''): boolean {
  mkdirFor(path);

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

/** Write via a uniquely named temp file and rename, so a reader never sees half a file. */
function writeAtomic(path: string, text: string) {
  mkdirFor(path);

  const tmp = `${path}.${randomId('t')}.tmp`;

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

/**
 * Remove `path` if it's older than `ageMs`, without ever removing a fresh one someone else just
 * created: read its contents (a random token) first, move it aside, and delete it only if the
 * moved file still holds that token. Otherwise put it back and leave it.
 */
function breakIfStale(path: string, ageMs: number) {
  let seen: string | null;

  try {
    if (Date.now() - statSync(path).mtimeMs <= ageMs) {
      return;
    }

    seen = readOrNull(path);
  } catch {
    return; // already gone
  }

  const aside = `${path}.${randomId('s')}.stale`;

  try {
    renameSync(path, aside);
  } catch {
    return; // someone else moved it first
  }

  if (seen !== null && readOrNull(aside) === seen) {
    rmSync(aside, { force: true });

    return;
  }

  // We moved a fresh file: put it back unless another has taken its place.
  try {
    linkSync(aside, path);
  } catch {
    // a newer one exists; the moved file's owner sees its token gone and fails closed
  }

  rmSync(aside, { force: true });
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

/** Names are b64url ids, receipt ids or measure names; anything else is refused. */
function safeName(s: string): string {
  if (!/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$/.test(s)) {
    throw new Error(`refusing an unsafe store name: ${JSON.stringify(s)}`);
  }

  return s;
}

/** Take a lock file (O_EXCL) holding a fresh token, retrying for up to 2 s; returns the token. */
async function acquire(lock: string): Promise<string> {
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
  if (typeof process.getuid !== 'function') {
    return "can't check who owns the principal key file on this platform";
  }

  if (process.getuid() === 0) {
    return 'refusing to trust a principal key file while running as root: run the server as its own user';
  }

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
