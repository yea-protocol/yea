/**
 * A grant's caveats as the short terms the hero lists above the exchange: `shop.example and
 * calendar.example`, `low risk only`, `$40 each`, `$100 in total`, `8 hours`. Each keeps its
 * caveat's name, so the page can mark the one that decided an example's outcome.
 *
 * It imports only policy.ts, by its full name, so the tests can load it under Node.
 */
import type { Caveat } from '@yea-protocol/sdk';
import { amount, span } from './policy.ts';

/** The caveats a term can come from, in the order the page lists them. */
export type TermKey = 'svc' | 'risk' | 'each' | 'total' | 'exp';

export interface PolicyTerm {
  key: TermKey;
  text: string;
}

const ORDER: readonly TermKey[] = ['svc', 'risk', 'each', 'total', 'exp'];

const RISK: Record<string, string> = {
  low: 'low risk only',
  medium: 'up to medium risk',
  high: 'any risk',
};

/** One caveat as a term, or null for a caveat the list doesn't say. */
function term(c: Caveat, issuedAt: number): PolicyTerm | null {
  if ('svc' in c) {
    return { key: 'svc', text: c.svc.join(' and ') };
  }

  if ('risk' in c) {
    return { key: 'risk', text: RISK[c.risk] ?? `${c.risk} risk` };
  }

  if ('each' in c) {
    return { key: 'each', text: `${amount(c.each)} each` };
  }

  if ('total' in c) {
    return { key: 'total', text: `${amount(c.total)} in total` };
  }

  if ('exp' in c) {
    return { key: 'exp', text: span(c.exp - issuedAt) };
  }

  return null;
}

/** The grant's terms, one per caveat the list knows, in the page's order. */
export function policyTerms(caveats: Caveat[], issuedAt: number): PolicyTerm[] {
  return caveats
    .map((c) => term(c, issuedAt))
    .filter((t): t is PolicyTerm => t !== null)
    .sort((a, b) => ORDER.indexOf(a.key) - ORDER.indexOf(b.key));
}
