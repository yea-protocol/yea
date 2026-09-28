/** What the shop example's asks return: meals matching a query, tag and calorie cap, and your orders. */
import { catalog, type Order } from './data.js';

export function search(params: {
  query?: unknown;
  tag?: string;
  max_cal?: number;
}) {
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

export function orderList(orders: Map<string, Order>) {
  return [...orders.values()].map((o) => ({
    id: o.id,
    usd: o.total / 100,
    status: o.status,
  }));
}
