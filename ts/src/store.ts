/**
 * Where the approval core keeps what must outlive one call (docs/framework/SPEC-approval.md §8):
 * consumed approvals, job receipts, undo markers, reservations against `total` limits, and
 * consents from `yea approve`. `MemoryStore` is here; `FileStore` is in the Node entry.
 */
import { randomId } from './crypto.js';
import type { Receipt } from './types.js';

/** A `total` limit's ledger entry: a policy grant block id and a measure name. */
export interface LedgerKey {
  block: string;
  of: string;
}

/** An amount held against a `total` until the job settles or fails. */
export interface Reservation {
  id: string;
  key: LedgerKey;
  amount: bigint;
}

/** SPEC.md's receipt, plus what undo needs to call the tool's `revert` from any process. */
export interface JobReceipt extends Receipt {
  tool: string;
  input: unknown;
  planHash: string;
  sub: string;
}

export interface ApprovalStore {
  /** True the first time `id` is consumed; false ever after (until `expiresAt` passes). */
  consumeOnce(id: string, expiresAt: number): Promise<boolean>;
  putReceipt(r: JobReceipt): Promise<void>;
  getReceipt(id: string): Promise<JobReceipt | null>;
  /** True the first time only; false if already claimed or undone. */
  claimUndo(id: string): Promise<boolean>;
  releaseUndo(id: string): Promise<void>;
  markUndone(id: string): Promise<void>;
  /** Hold `amount` against `key` unless settled + reserved + amount would pass `max`. */
  reserve(
    key: LedgerKey,
    amount: bigint,
    max: bigint,
  ): Promise<Reservation | null>;
  settle(r: Reservation): Promise<void>;
  release(r: Reservation): Promise<void>;
  /** Settled plus reserved, for `decide`. */
  used(key: LedgerKey): Promise<bigint>;
  putConsent(planHash: string, grant: string): Promise<void>;
  getConsent(planHash: string): Promise<string | null>;
}

/** Keys a ledger entry by its block and measure (a block id never contains a space). */
export const ledgerId = (k: LedgerKey) => `${k.block} ${k.of}`;

interface Ledger {
  settled: bigint;
  reserved: Map<string, bigint>;
}

const total = (l: Ledger) =>
  [...l.reserved.values()].reduce((a, b) => a + b, l.settled);

/** The default store for a single process (SPEC-approval §8). */
export class MemoryStore implements ApprovalStore {
  private consumed = new Map<string, number>();
  private receipts = new Map<string, JobReceipt>();
  private undo = new Map<string, 'claimed' | 'done'>();
  private ledgers = new Map<string, Ledger>();
  private consents = new Map<string, string>();

  consumeOnce(id: string, expiresAt: number): Promise<boolean> {
    if (this.consumed.has(id)) {
      return Promise.resolve(false);
    }

    this.consumed.set(id, expiresAt);

    return Promise.resolve(true);
  }

  putReceipt(r: JobReceipt): Promise<void> {
    this.receipts.set(r.id, structuredClone(r));

    return Promise.resolve();
  }

  getReceipt(id: string): Promise<JobReceipt | null> {
    const r = this.receipts.get(id);

    return Promise.resolve(r ? structuredClone(r) : null);
  }

  claimUndo(id: string): Promise<boolean> {
    if (this.undo.has(id)) {
      return Promise.resolve(false);
    }

    this.undo.set(id, 'claimed');

    return Promise.resolve(true);
  }

  releaseUndo(id: string): Promise<void> {
    if (this.undo.get(id) === 'claimed') {
      this.undo.delete(id);
    }

    return Promise.resolve();
  }

  markUndone(id: string): Promise<void> {
    this.undo.set(id, 'done');

    return Promise.resolve();
  }

  reserve(
    key: LedgerKey,
    amount: bigint,
    max: bigint,
  ): Promise<Reservation | null> {
    const ledger = this.ledger(key);

    if (total(ledger) + amount > max) {
      return Promise.resolve(null);
    }

    const id = randomId('v');

    ledger.reserved.set(id, amount);

    return Promise.resolve({ id, key, amount });
  }

  settle(r: Reservation): Promise<void> {
    const ledger = this.ledger(r.key);

    if (ledger.reserved.delete(r.id)) {
      ledger.settled += r.amount;
    }

    return Promise.resolve();
  }

  release(r: Reservation): Promise<void> {
    this.ledger(r.key).reserved.delete(r.id);

    return Promise.resolve();
  }

  used(key: LedgerKey): Promise<bigint> {
    return Promise.resolve(total(this.ledger(key)));
  }

  putConsent(planHash: string, grant: string): Promise<void> {
    this.consents.set(planHash, grant);

    return Promise.resolve();
  }

  getConsent(planHash: string): Promise<string | null> {
    return Promise.resolve(this.consents.get(planHash) ?? null);
  }

  private ledger(key: LedgerKey): Ledger {
    const id = ledgerId(key);
    let l = this.ledgers.get(id);

    if (!l) {
      l = { settled: 0n, reserved: new Map() };
      this.ledgers.set(id, l);
    }

    return l;
  }
}
