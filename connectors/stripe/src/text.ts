/**
 * Customer text is untrusted: customers set their own names, emails and descriptions. In
 * summaries and effects it is quoted, capped, and escaped the way `yea approve` escapes
 * (`printable`), so a name can't forge a line, a fake `[test]`, or a closing quote.
 */
import { printable } from '@yea-protocol/sdk';
import type { Stripe } from './api.js';

/** What a summary shows of a customer. */
type Named = Pick<Stripe.Customer, 'id' | 'name' | 'email'>;

/** The longest piece of customer text shown, in characters. */
const MAX_TEXT = 80;

/** At most `MAX_TEXT` characters, with `…` when cut. */
function cap(s: string): string {
  const chars = [...s];

  return chars.length > MAX_TEXT ? `${chars.slice(0, MAX_TEXT).join('')}…` : s;
}

/** Capped, with control and bidi characters escaped. */
export const safeText = (s: string) => printable(cap(s));

/**
 * Untrusted text in double quotes: `\` and `"` escaped first, so it can't end the quote, then
 * control and bidi characters.
 */
export const quoted = (s: string) =>
  `"${printable(cap(s).replace(/[\\"]/g, (c) => `\\${c}`))}"`;

/** How a summary names a customer: their quoted name, else email, else id. */
export function who(c: Named): string {
  if (c.name) {
    return quoted(c.name);
  }

  return c.email ? quoted(c.email) : c.id;
}

/** A list label for a customer: quoted name and email, and the id. */
export function label(c: Named): string {
  const parts = [
    c.name ? quoted(c.name) : null,
    c.email ? quoted(c.email) : null,
  ]
    .filter(Boolean)
    .join(' ');

  return parts ? `${parts} (${c.id})` : c.id;
}

const PLAIN_EMAIL = /^[A-Za-z0-9._%+'-]{1,64}@[A-Za-z0-9.-]{1,190}$/;

/**
 * What a person types to approve a cancel or plan change: the customer's email, or the id when
 * there is no email, or the email has anything a person couldn't read and type as it is.
 */
export function confirmPhrase(c: Named): string {
  return c.email && PLAIN_EMAIL.test(c.email) ? c.email : c.id;
}
