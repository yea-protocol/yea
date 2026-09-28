/**
 * What has run out on the slip: the example policy (8 hours), the proposal (it expires a few
 * minutes after it's made) or the undo window (2 hours). Checked before each step, and on a
 * timer, so the slip says so instead of failing.
 *
 * No runtime imports, so Node can load it in tests.
 */

export type Lapse = 'policy' | 'proposal' | 'undo';

export interface Deadlines {
  /** When the policy grant expires, in unix seconds. */
  grant: number;
  /** When the waiting proposal expires, if one is waiting. */
  proposal?: number | null;
  /** When the committed receipt's undo window closes, if one is open. */
  undo?: number | null;
}

/** The first thing that has run out at `now` (unix seconds), policy first; or null. */
export function lapsed(now: number, d: Deadlines): Lapse | null {
  if (now >= d.grant) {
    return 'policy';
  }

  if (d.proposal != null && now >= d.proposal) {
    return 'proposal';
  }

  return d.undo != null && now >= d.undo ? 'undo' : null;
}

/** What the slip says about a lapse; `at` is when it happened, as `14:00 UTC`. */
export function lapseText(l: Lapse, at: string): string {
  switch (l) {
    case 'policy':
      return `The example policy expired at ${at}. Start again to sign a new one.`;
    case 'proposal':
      return `This proposal expired at ${at} before anyone approved it, so it can't be committed. Start again for a new one.`;
    case 'undo':
      return `The undo window closed at ${at}, so the order stands. Start again for a new proposal.`;
  }
}
