/**
 * A meal-delivery shop that speaks YEA. Shows budgets (a big catalog, fitted to the
 * agent's token budget with EXPAND handles), money (what each order spends, and spend
 * limits in grants) and human consent for anything over the agent's limits.
 */
import {
  create,
  fix,
  type Plan,
  quantity,
  service,
  YeaError,
} from '../index.js';

/** Cents charged, reported under the `spend` convention (docs/conventions.md). */
const spent = (cents: number) => ({
  spend: quantity(cents, { scale: 2, unit: 'USD' }),
});

const MENU: [string, string[]][] = [
  ['Miso Glazed Salmon', ['high-protein']],
  ['Chicken Tikka Masala', ['high-protein', 'spicy']],
  ['Mushroom Risotto', ['vegetarian']],
  ['Beef Bulgogi Bowl', ['high-protein', 'spicy']],
  ['Falafel Plate', ['vegan', 'vegetarian']],
  ['Turkey Chili', ['high-protein', 'spicy']],
  ['Tofu Pad Thai', ['vegan', 'vegetarian']],
  ['Lemon Herb Chicken', ['high-protein']],
  ['Shrimp Tacos', ['spicy']],
  ['Lentil Curry', ['vegan', 'vegetarian', 'spicy']],
  ['Steak Frites', ['high-protein']],
  ['Veggie Lasagna', ['vegetarian']],
  ['Cod Piccata', ['high-protein']],
  ['Pork Carnitas', ['high-protein']],
  ['Chickpea Shawarma', ['vegan', 'vegetarian']],
  ['Teriyaki Chicken', ['high-protein']],
  ['Eggplant Parm', ['vegetarian']],
  ['Salmon Poke', ['high-protein']],
  ['Chicken Pho', ['high-protein']],
  ['Black Bean Burrito', ['vegan', 'vegetarian']],
];

export interface Meal {
  sku: string;
  name: string;
  price: number;
  cal: number;
  protein: number;
  tags: string[];
}

export const catalog: Meal[] = Array.from({ length: 60 }, (_, i) => ({
  sku: `m${String(i + 1).padStart(3, '0')}`,
  name:
    MENU[i % MENU.length][0] +
    (i >= MENU.length
      ? ` (${['family', 'light'][Math.floor(i / MENU.length) - 1]})`
      : ''),
  price: 1099 + ((i * 137) % 900),
  cal: 420 + ((i * 53) % 380),
  protein: 18 + ((i * 7) % 30),
  tags: MENU[i % MENU.length][1],
}));

interface Order {
  id: string;
  total: number;
  status: string;
}
interface Line extends Meal {
  qty: number;
}
interface Cart {
  lines: Line[];
  subtotal: number;
  fee: number;
  deliver: string;
}

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
      run: () =>
        [...orders.values()].map((o) => ({
          id: o.id,
          usd: o.total / 100,
          status: o.status,
        })),
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
      plan: ({ params }) => ({
        summary: `Tip ${params.usd} USD on ${params.order}`,
        effects: [create('tip', `${params.usd} USD to card ••4242`)],
        uses: spent(Math.round(params.usd * 100)),
        apply: () => ({ tipped: params.usd }),
      }),
    });
}

function search(params: { query?: unknown; tag?: string; max_cal?: number }) {
  return catalog
    .filter(
      (m) =>
        !params.query ||
        m.name.toLowerCase().includes(String(params.query).toLowerCase()),
    )
    .filter((m) => !params.tag || m.tags.includes(params.tag))
    .filter((m) => !params.max_cal || m.cal <= params.max_cal)
    .map((m) => ({
      sku: m.sku,
      name: m.name,
      usd: m.price / 100,
      cal: m.cal,
      protein: m.protein,
    }));
}

function checkout(
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

function orderPlan(
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
