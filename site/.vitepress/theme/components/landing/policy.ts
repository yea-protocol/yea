/**
 * The landing's example policy: the caveats of the grant the person signs for their agent
 * (the shop only, $40 per action, $100 in total, low risk, eight hours), and the plain
 * sentence the page shows for any such grant.
 *
 * No runtime imports, so the recording script and the tests can load it under Node.
 */
import type { Caveat, Limit } from '@yea-protocol/sdk';

/** How long the example grant lasts. */
export const POLICY_HOURS = 8;

/** A USD amount in cents, as a spend limit. */
const usd = (cents: number): Limit => ({
  of: 'spend',
  max: cents,
  scale: 2,
  unit: 'USD',
});

/** The example policy's caveats, expiring POLICY_HOURS after `now` (unix seconds). */
export const landingCaveats = (now: number): Caveat[] => [
  { svc: ['shop.example'] },
  { risk: 'low' },
  { each: usd(4000) },
  { total: usd(10000) },
  { exp: now + POLICY_HOURS * 3600 },
];

/** A limit as a reader says it: `$40`, `$12.50`, or `3 emails`. */
export function amount(limit: Limit): string {
  const value = limit.max / 10 ** (limit.scale ?? 0);

  if (limit.of === 'spend' && limit.unit === 'USD') {
    return `$${Number.isInteger(value) ? value : value.toFixed(2)}`;
  }

  return limit.unit
    ? `${value} ${limit.unit} of ${limit.of}`
    : `${value} ${limit.of}`;
}

/** A duration in seconds as a reader says it: `8 hours`, `1 day`, `15 minutes`. */
export function span(seconds: number): string {
  const [n, unit] =
    seconds % 86400 === 0
      ? [seconds / 86400, 'day']
      : seconds % 3600 === 0
        ? [seconds / 3600, 'hour']
        : [Math.round(seconds / 60), 'minute'];

  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

const RISK: Record<string, string> = {
  low: 'low-risk actions',
  medium: 'actions up to medium risk',
  high: 'actions of any risk',
};

/** The parts of a sentence a grant's caveats fill; caveats the sentence doesn't know are skipped. */
interface Parts {
  when?: string;
  what?: string;
  where?: string;
  each?: string;
  total?: string;
}

function parts(caveats: Caveat[], issuedAt: number): Parts {
  const out: Parts = {};

  for (const c of caveats) {
    if ('exp' in c) {
      out.when = `For the next ${span(c.exp - issuedAt)}`;
    } else if ('risk' in c) {
      out.what = RISK[c.risk];
    } else if ('svc' in c) {
      out.where = `at ${c.svc.join(' or ')}`;
    } else if ('each' in c) {
      out.each = `${amount(c.each)} each`;
    } else if ('total' in c) {
      out.total = `${amount(c.total)} in total`;
    }
  }

  return out;
}

/**
 * The grant as one sentence: "For the next 8 hours, your agent may take low-risk actions at
 * shop.example that spend up to $40 each and $100 in total." It covers expiry, risk,
 * services and spend limits; the page shows the signed caveats beside it for the rest.
 */
export function policySentence(caveats: Caveat[], issuedAt: number): string {
  const p = parts(caveats, issuedAt);
  const limits = [p.each, p.total].filter(Boolean).join(' and ');
  const words = [
    `your agent may take ${p.what ?? 'actions'}`,
    p.where,
    limits && `that spend up to ${limits}`,
  ].filter(Boolean);
  const sentence = words.join(' ');

  return p.when
    ? `${p.when}, ${sentence}.`
    : `${sentence[0].toUpperCase()}${sentence.slice(1)}.`;
}
