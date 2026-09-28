/** What the billing example's asks return: a customer search, and one customer in detail. */
import { type Customer, date, PRICES } from './data.js';
import { find } from './lookup.js';

export function search(
  customers: Customer[],
  params: { query?: string; status?: string },
) {
  return (params.query ? find(customers, params.query) : customers)
    .filter((c) => !params.status || c.status === params.status)
    .map((c) => ({
      id: c.id,
      name: c.name,
      email: c.email,
      plan: c.plan,
      status: c.status,
      renews: date(c.renews),
    }));
}

export function details(c: Customer) {
  return {
    id: c.id,
    name: c.name,
    email: c.email,
    plan: c.plan,
    usd_month: PRICES[c.plan] / 100,
    status: c.status,
    card: c.card,
    renews: date(c.renews),
    ...(c.nextPlan ? { next_plan: c.nextPlan } : {}),
    ...(c.cancelAt ? { cancels: date(c.cancelAt) } : {}),
    payments: c.payments.map((p) => ({
      id: p.id,
      date: date(p.at),
      usd: p.amount / 100,
      status: p.status,
      refunded_usd: p.refunded / 100,
    })),
  };
}
