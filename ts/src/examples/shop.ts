/**
 * A meal-delivery shop that speaks YEA. Shows budgets (a big catalog, fitted to the
 * agent's token budget with EXPAND handles), money (what each order spends, and spend
 * limits in grants) and human consent for anything over the agent's limits.
 *
 * This file declares the service: each capability, its params and its risk. The code behind
 * them is in shop/: data.ts (the menu), reads.ts (what each ask returns) and plans.ts (what
 * each intent proposes).
 */
import { service } from '../index.js';
import type { Order } from './shop/data.js';
import { checkout, orderPlan, tipPlan } from './shop/plans.js';
import { orderList, search } from './shop/reads.js';

export { catalog, type Meal } from './shop/data.js';

export function shop(opts: {
  trust: string[] | ((principal: string) => boolean);
  id?: string;
}) {
  const orders = new Map<string, Order>();
  let seq = 1000;

  return service({
    id: opts.id ?? 'shop.example',
    name: 'Example Meals',
    summary:
      'Chef-made meal delivery. Search the menu, then order for a delivery date. Orders can be cancelled for 2 hours.',
    trust: opts.trust,
  })
    .ask('shop.search', {
      summary: 'Search the menu',
      params: {
        'query?': 'string',
        'tag?': 'high-protein|spicy|vegetarian|vegan',
        'max_cal?': 'int',
      },
      run: ({ params }) => search(params),
    })
    .ask('shop.orders', {
      summary: 'Your orders',
      run: () => orderList(orders),
    })
    .intent('shop.order', {
      summary: 'Order meals for delivery',
      params: { items: [{ sku: 'string', qty: 'int' }], deliver: 'date' },
      risk: 'low',
      plan: ({ params }) => {
        const cart = checkout(params.items, params.deliver);

        return [false, true].map((express) =>
          orderPlan(orders, cart, express, `o${++seq}`),
        );
      },
    })
    .intent('shop.tip', {
      summary: 'Tip your courier (irreversible)',
      params: { order: 'string', usd: 'number' },
      risk: 'medium',
      plan: ({ params }) => tipPlan(params.order, params.usd),
    });
}
