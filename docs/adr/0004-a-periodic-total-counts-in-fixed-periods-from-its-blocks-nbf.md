# A periodic total counts in fixed periods from its block's nbf

A `total` with `every` (SPEC.md §6.3) counts in fixed periods of `every` seconds, counted from
the `nbf` of the block that holds it. Period *k* covers [`nbf` + *k*·`every`,
`nbf` + (*k*+1)·`every`), and a commit counts in the period its service's clock is in. We chose
this over calendar periods and rolling windows.

- **Calendar periods** ("per calendar month", "per week from Monday") need a time zone, month
  lengths and daylight saving rules, and every implementation would have to agree on them byte
  for byte. Unix seconds and one division don't: two services with the same grant and the same
  clock always pick the same period, in TypeScript and Python alike.
- **Rolling windows** ("the last 7 days") need every commit's time kept until it ages out, and
  a check that sums them. Fixed periods need one ledger entry per period, keyed by its start,
  which the existing reservation (check and reserve in one step) already handles. A rolling
  window would also never say when room comes back in one sentence.
- **The anchor is the block's own `nbf`**, not a new field inside the limit. `nbf` already
  makes the grant fail before the first period starts, so there is never a period before it.
  A block with a periodic total must hold exactly one `nbf`, and only that block's `nbf`
  counts: a holder who appends a delegation block with its own `nbf` can't move the periods.

## Consequences

- Each period allows the `total`'s `max` of commits that run without asking. Periods are fixed,
  so `every` seconds that straddle a boundary can see twice that. Plans the person approved
  don't count, and undone ones still do.
- A periodic total renews until the grant ends, so its block or an earlier one must carry an
  `exp`, and tooling shows the worst case (`500.00 USD every 7d until …, at most 6500.00 USD`).
  A later block's `exp` doesn't count: the holder writes those, and could end its own
  allowance as late as it liked.
- The period is worked out once per commit and carried on the limit, the reservation request
  and the reservation, so an amount lands in the period that was checked even when the clock
  crosses a boundary between the check and the reservation.
- A block's totals on one measure share a reservation only when their `every` is equal: "100 a
  day and 500 a week" keeps both.
- The arithmetic is exact: `now − nbf` can pass 2^53, so the period is computed in big
  integers, and keyed by its start, which lies between `nbf` and now and so is always a safe
  integer.
