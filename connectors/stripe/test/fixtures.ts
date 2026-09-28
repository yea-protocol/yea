import type { Customer } from './fake-stripe.js';

/** `n` customers called `<name> 1`, `<name> 2`…. */
export const customersNamed = (name: string, n: number): Customer[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `cus_${name.toLowerCase()}${i + 1}`,
    name: `${name} ${i + 1}`,
    email: `${name.toLowerCase()}${i + 1}@example.com`,
  }));
