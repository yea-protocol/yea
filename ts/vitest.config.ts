import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
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
