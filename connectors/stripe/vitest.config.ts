import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (file: string) =>
  fileURLToPath(new URL(`./src/${file}`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      // examples/stripe-billing.ts, tested here, reads Stripe through this package's source.
      '@yea-protocol/stripe/api': src('api.ts'),
      '@yea-protocol/stripe/currency': src('currency.ts'),
    },
  },
});
