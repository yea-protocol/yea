/**
 * The colour class of a Lens line, by protocol state: green for a receipt, amber for a
 * proposal or a consent request, red for a refusal, and quieter classes for effects and
 * handles. Shared by the playground and the landing.
 *
 * No runtime imports, so Node can load it in tests.
 */

/** A Lens line's class. `consent` says a ✗ line is a consent request (amber), not a refusal. */
export function lineClass(l: string, consent: boolean): string {
  if (l.startsWith('✓')) {
    return 'green';
  }

  if (l.startsWith('✗')) {
    return consent ? 'amber' : 'red';
  }

  if (l.startsWith('? ') || /^\d+ proposals?/.test(l) || /^\[p_/.test(l)) {
    return 'amber';
  }

  if (l.startsWith('… ') && l.includes(' more at ')) {
    return 'more';
  }

  return /^ {2}[~+\-$>*] /.test(l) ? 'effect' : '';
}
