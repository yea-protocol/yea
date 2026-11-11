/**
 * How the vectors write what a `total` has used: as FileStore lays the ledger out
 * (SPEC-approval §8), `{"spend": q}` for a total and `{"spend@604800": {"1789776000": q}}` for
 * one period of one with `every`. Shared by the generators that write `used`.
 */

/** The quantity `used` holds for ledger key `k`'s measure and period: zero when none. */
export const usedAt = (used, k) =>
  (k.period
    ? used?.[`${k.of}@${k.period.every}`]?.[k.period.start]
    : used?.[k.of]) ?? { amount: 0 };
