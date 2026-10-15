/**
 * The usage ledger (GLOSSARY.md): the amount used against each `total` limit, settled and
 * reserved. It is held in process, with ApprovalStore's names and shapes, but synchronous, so a
 * commit checks and reserves in one step that no other commit can come between.
 */
import { type TotalLimit, usedOf } from '../../grants.js';
import { type LedgerKey, ledgerId, type Reservation } from '../../store.js';
import type { Proposal } from '../../types.js';
import { exact } from '../../uses.js';

interface Ledger {
  settled: bigint;
  reserved: Map<string, bigint>;
}

/** What a commit holds: every reservation, or the limit one of them would pass. */
export type Held = { held: Reservation[] } | { over: TotalLimit };

export class UsageLedger {
  private readonly ledgers = new Map<string, Ledger>();
  private reservations = 0;

  /** Settled plus reserved. */
  used(key: LedgerKey): bigint {
    const l = this.ledgers.get(ledgerId(key));

    return l ? [...l.reserved.values()].reduce((a, b) => a + b, l.settled) : 0n;
  }

  /** Hold `amount` against `key` unless settled + reserved + amount would pass `max`. */
  reserve(key: LedgerKey, amount: bigint, max: bigint): Reservation | null {
    if (this.used(key) + amount > max) {
      return null;
    }

    const id = `v${++this.reservations}`;

    this.ledger(key).reserved.set(id, amount);

    return { id, key, amount };
  }

  settle(r: Reservation) {
    const l = this.ledger(r.key);

    if (l.reserved.delete(r.id)) {
      l.settled += r.amount;
    }
  }

  release(r: Reservation) {
    this.ledger(r.key).reserved.delete(r.id);
  }

  /**
   * Reserve the proposal's uses against every `total` it counts against, all or nothing: once
   * per block and measure, under the smallest `max` when a block repeats a limit.
   */
  reserveAll(proposal: Proposal, totals: TotalLimit[]): Held {
    const held: Reservation[] = [];

    for (const t of smallestPerKey(totals)) {
      const q = usedOf(proposal.uses, t.of);

      if (!q) {
        continue;
      }

      const r = this.reserve({ block: t.id, of: t.of }, exact(q), t.max);

      if (!r) {
        for (const h of held) {
          this.release(h);
        }

        return { over: t };
      }

      held.push(r);
    }

    return { held };
  }

  private ledger(key: LedgerKey): Ledger {
    const id = ledgerId(key);
    const l = this.ledgers.get(id) ?? { settled: 0n, reserved: new Map() };

    this.ledgers.set(id, l);

    return l;
  }
}

/** One limit per block and measure: the smallest, when a block repeats one. */
function smallestPerKey(totals: TotalLimit[]): TotalLimit[] {
  const out = new Map<string, TotalLimit>();

  for (const t of totals) {
    const id = ledgerId({ block: t.id, of: t.of });
    const seen = out.get(id);

    if (!seen || t.max < seen.max) {
      out.set(id, t);
    }
  }

  return [...out.values()];
}
