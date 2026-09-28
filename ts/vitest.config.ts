import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // examples/stripe-billing.ts reads Stripe through the connector's dependency-free client.
      '@yea-protocol/stripe/api': fileURLToPath(
        new URL('../connectors/stripe/src/api.ts', import.meta.url),
      ),
      '@yea-protocol/stripe/currency': fileURLToPath(
        new URL('../connectors/stripe/src/currency.ts', import.meta.url),
      ),
      '@yea-protocol/sdk/examples': fileURLToPath(
        new URL('./src/examples/index.ts', import.meta.url),
      ),
      '@yea-protocol/sdk': fileURLToPath(
        new URL('./src/index.ts', import.meta.url),
      ),
    },
  },
  test: { include: ['test/**/*.test.ts'] },
});
