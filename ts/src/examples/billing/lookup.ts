/**
 * Finding the customer an agent means, by name, email or id: an ask that matches several
 * teaches with one fix per candidate, and an intent answers with CLARIFY.
 */
import { clarify, fail, fix, type Plan } from '../../index.js';
import type { Customer } from './data.js';

// Agents refer to people the way the user did ("Ana", an email); the service resolves it.
export function find(customers: Customer[], who: string) {
  const q = who.toLowerCase().trim();
  const exact = customers.find((c) => c.id === q || c.email === q);

  if (exact) {
    return [exact];
  }

  const words = q.split(/\s+/).filter(Boolean);
  // Each word must start a word of the name or email: "ana" finds Ana Ruiz, not Dana Park.
  const tokens = (c: Customer) =>
    `${c.name} ${c.email}`.toLowerCase().split(/[^a-z0-9]+/);

  return customers.filter((c) =>
    words.every((w) => tokens(c).some((t) => t.startsWith(w))),
  );
}

const label = (c: Customer) => `${c.name} <${c.email}> · ${c.plan}`;
const notFound = (who: string) =>
  fail('not_found', `no customer matches ${JSON.stringify(who)}`, {
    fix: [fix('ASK billing.customers to search')],
  });

// An ASK can't CLARIFY, so an ambiguous read teaches instead: one fix per candidate.
export function findOne(customers: Customer[], who: string) {
  const m = find(customers, who);

  if (!m.length) {
    notFound(who);
  }

  if (m.length > 1) {
    fail(
      'invalid_params',
      `${m.length} customers match ${JSON.stringify(who)}`,
      {
        fix: m.map((c) => fix(`use ${label(c)}`, { who: c.id })),
      },
    );
  }

  return m[0];
}

// Intents answer ambiguity with CLARIFY; each option is a params patch the agent merges.
export function pickOne(
  customers: Customer[],
  who: string,
  then: (c: Customer) => Plan | Plan[],
) {
  const m = find(customers, who);

  if (!m.length) {
    notFound(who);
  }

  if (m.length > 1) {
    return clarify(
      `${m.length} customers match "${who}". Which one?`,
      m.map((c) => ({ label: label(c), params: { who: c.id } })),
    );
  }

  return then(m[0]);
}
