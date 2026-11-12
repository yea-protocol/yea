/**
 * The README's "As a library" example (examples/stripe-connector.ts, shown there whole) serves
 * the connector's tools, started as its own process over stdio. Node runs the .ts file itself
 * from 22.18, so the test skips on older Node, and when the packages aren't built.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { describe, expect, it } from 'vitest';
import { tmp } from './helpers.js';

const EXAMPLE = fileURLToPath(
  new URL('../../../examples/stripe-connector.ts', import.meta.url),
);
const BUILT = existsSync(new URL('../dist/index.js', import.meta.url));

describe.skipIf(!process.features.typescript || !BUILT)(
  'examples/stripe-connector.ts',
  () => {
    it('serves the four tools and undo on stdio', async () => {
      const client = new Client({ name: 'c', version: '1' });

      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [EXAMPLE],
          env: {
            PATH: process.env.PATH ?? '',
            YEA_HOME: tmp(),
            STRIPE_SECRET_KEY: 'sk_test_51abcDEF',
          },
          stderr: 'pipe',
        }),
      );

      try {
        const { tools } = await client.listTools();

        expect(tools.map((t) => t.name).sort()).toEqual([
          'cancel_subscription',
          'change_plan',
          'customer',
          'refund',
          'undo',
        ]);
      } finally {
        await client.close();
      }
    });
  },
);
