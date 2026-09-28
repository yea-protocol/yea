/**
 * Subscription billing that speaks YEA: the worked example in the service design guide
 * (site/guide/service-design.md). It covers the jobs a support or finance agent does with
 * a payments API such as Stripe's: look a customer up, refund, change plan, cancel. Here
 * they're designed as outcomes instead of resources. The data is made up.
 *
 * This file declares the service: each capability, its params and its risk. The code behind
 * them is in billing/: data.ts (the customers), lookup.ts (finding the one the agent means),
 * reads.ts (what each ask returns) and plans.ts (what each intent proposes).
 */
import { type Plan, service } from '../index.js';
import { type Customer, seedCustomers } from './billing/data.js';
import { findOne, pickOne } from './billing/lookup.js';
import { cancelPlans, changePlans, refundPlans } from './billing/plans.js';
import { details, search } from './billing/reads.js';

export function billing(opts: {
  trust: string[] | ((principal: string) => boolean);
  id?: string;
}) {
  // Computed per call, not at module load: some runtimes (Workers) freeze the clock during startup.
  const now = Date.now();
  const customers = seedCustomers(now);
  const pick = (who: string, then: (c: Customer) => Plan | Plan[]) =>
    pickOne(customers, who, then);

  return service({
    id: opts.id ?? 'billing.example',
    name: 'Example Billing',
    summary:
      "Subscriptions for a SaaS product: plans starter 19, pro 49, team 99 USD/month. Refer to customers by name, email or id. Refunds and immediate cancellations can't be undone.",
    trust: opts.trust,
  })
    .ask('billing.customers', {
      summary: 'Find customers',
      params: {
        'query?': 'string — name or email',
        'status?': 'active|past_due|canceled',
      },
      run: ({ params }) => search(customers, params),
    })
    .ask('billing.customer', {
      summary: 'One customer: plan, card, and recent payments',
      params: { who: 'string — name, email or id' },
      run: ({ params }) => details(findOne(customers, params.who)),
    })
    .intent('billing.refund', {
      summary: 'Refund a payment (irreversible)',
      params: {
        who: 'string',
        'payment?': 'string — default: latest paid',
        'usd?': 'number — partial amount',
        'reason?': 'duplicate|requested_by_customer|fraudulent',
      },
      risk: 'medium',
      plan: ({ params }) =>
        pick(params.who, (c) => refundPlans(c, params, now)),
    })
    .intent('billing.change_plan', {
      summary: 'Move a customer to another plan',
      params: { who: 'string', plan: 'starter|pro|team' },
      risk: 'low',
      plan: ({ params }) =>
        pick(params.who, (c) => changePlans(c, params.plan, now)),
    })
    .intent('billing.cancel', {
      summary: 'Cancel a subscription',
      params: { who: 'string' },
      risk: 'low',
      plan: ({ params }) => pick(params.who, (c) => cancelPlans(c, now)),
    });
}
