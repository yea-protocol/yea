/**
 * What the shop example's intents propose: an order (a cart checked against the menu, then a
 * Plan per delivery speed, with what it spends, a risk that grows with the total, and two hours
 * to undo), and a tip, which can't be undone.
 */
import { create, fix, type Plan, quantity, YeaError } from '../../index.js';
import { catalog, type Meal, type Order } from './data.js';

/** Cents charged, reported under the `spend` convention (docs/conventions.md). */
const spent = (cents: number) => ({
  spend: quantity(cents, { scale: 2, unit: 'USD' }),
});

interface Line extends Meal {
  qty: number;
}
interface Cart {
  lines: Line[];
  subtotal: number;
  fee: number;
  deliver: string;
}

export function checkout(
  items: { sku: string; qty: number }[],
  deliver: string,
): Cart {
  const lines = items.map((it) => {
    const m = catalog.find((c) => c.sku === it.sku);

    if (!m) {
      throw new YeaError(
        'invalid_params',
        `unknown sku ${JSON.stringify(it.sku)}`,
        { fix: [fix('ASK shop.search to find skus')] },
      );
    }

    return { ...m, qty: it.qty };
  });
  const subtotal = lines.reduce((s, l) => s + l.price * l.qty, 0);

  return { lines, subtotal, fee: subtotal >= 5000 ? 0 : 599, deliver };
}

const riskFor = (total: number) => {
  if (total > 15000) {
    return 'high';
  }

  return total > 8000 ? 'medium' : 'low';
};

export function orderPlan(
  orders: Map<string, Order>,
  { lines, subtotal, fee, deliver }: Cart,
  express: boolean,
  id: string,
): Plan {
  const total = subtotal + fee + (express ? 899 : 0);
  const meals = lines.reduce((n, l) => n + l.qty, 0);
  const placed: Order = { id, total, status: 'placed' };

  return {
    summary: `${meals} meals for ${deliver}${express ? ' (express, by noon)' : ''} — ${(total / 100).toFixed(2)} USD`,
    effects: [
      create(`order/${id}`, lines.map((l) => `${l.qty}× ${l.name}`).join(', ')),
      create('charge', `${(total / 100).toFixed(2)} USD to card ••4242`),
    ],
    uses: spent(total),
    risk: riskFor(total),
    undoWindow: 7200,
    data: {
      subtotal: subtotal / 100,
      delivery: fee / 100,
      ...(express ? { express: 8.99 } : {}),
    },
    apply: (ctx) => {
      ctx.progress('authorizing card', 0.3);
      ctx.progress('order placed with kitchen', 0.9);
      orders.set(id, placed);

      return { order: id, status: 'placed' };
    },
    revert: () => {
      placed.status = 'cancelled';
    },
  };
}

export function tipPlan(order: string, usd: number): Plan {
  return {
    summary: `Tip ${usd} USD on ${order}`,
    effects: [create('tip', `${usd} USD to card ••4242`)],
    uses: spent(Math.round(usd * 100)),
    apply: () => ({ tipped: usd }),
  };
}
