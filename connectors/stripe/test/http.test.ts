import type { AddressInfo } from 'node:net';
import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { yea } from '@yea-protocol/mcp';
import { httpApp, httpGate, subOf } from '@yea-protocol/mcp/http';
import { serveHttp } from '@yea-protocol/mcp/http/node';
import { MemoryStore } from '@yea-protocol/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { stripeServer } from '../src/server.js';
import { fakeStripe } from './fake-stripe.js';
import { NOW, suggestedGrant, TEST_KEY, textOf, world } from './helpers.js';

const TOKEN = 't'.repeat(40);

afterEach(() => {
  delete process.env.YEA_HOME;
  delete process.env.YEA_POLICY;
});

/** The connector over HTTP, as `yea-stripe --http` builds it, on a MemoryStore. */
async function httpWorld() {
  const w = await world();
  const approvals = yea({
    name: 'yea-stripe',
    transport: 'http',
    store: new MemoryStore(),
    singleProcess: true,
    sub: subOf,
    principal: w.principal.public,
  });
  const stripe = fakeStripe({ now: NOW });
  const front = {
    token: TOKEN,
    sub: 'person-1',
    loopback: true,
    clientId: 'yea-stripe-http',
  };
  const app = httpApp(
    stripeServer({
      key: TEST_KEY,
      approvals,
      fetch: stripe.fetch,
      now: () => NOW,
    }),
    front,
  );

  return { w: { ...w, approvals }, stripe, app, gate: httpGate(front) };
}

/**
 * The connector over `yea-stripe --http`. The token, Host and body-cap checks are
 * @yea-protocol/mcp/http's, tested in mcp/test/http.test.ts.
 */
describe('--http', () => {
  it('serves the person with the token: jobs run as their sub', async () => {
    const { w, stripe, app, gate } = await httpWorld();

    await suggestedGrant(w);

    const server = await serveHttp(app, {
      port: 0,
      host: '127.0.0.1',
      gate,
    });
    const { port } = server.address() as AddressInfo;
    const client = new Client(
      { name: 'c', version: '1' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } },
    );

    try {
      await client.connect(
        new StreamableHTTPClientTransport(
          new URL(`http://127.0.0.1:${port}/mcp`),
          {
            requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
          },
        ),
      );

      const r = await client.callTool({
        name: 'cancel_subscription',
        arguments: { customer: 'chen@wei.studio' },
      });

      expect(textOf(r)).toMatch(/^✓ \[test\] Cancel/);
      expect(
        (r.structuredContent as { receipt: { sub: string } }).receipt.sub,
      ).toBe('person-1');
      expect(stripe.subs[0].cancel_at_period_end).toBe(true);
    } finally {
      await client.close();
      server.close();
    }
  });
});
