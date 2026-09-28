import type { AddressInfo } from 'node:net';
import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { yea } from '@yea-protocol/mcp';
import { MemoryStore } from '@yea-protocol/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { httpApp, httpAuthFrom, serveHttp, subOf } from '../src/http.js';
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
  const app = httpApp(
    stripeServer({
      key: TEST_KEY,
      approvals,
      fetch: stripe.fetch,
      now: () => NOW,
    }),
    { token: TOKEN, sub: 'person-1', loopback: true },
  );

  return { w: { ...w, approvals }, stripe, app };
}

const post = (headers: Record<string, string>) =>
  new Request('http://localhost/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });

describe('--http', () => {
  it('needs a bearer token of 32 or more characters, and the person it acts for', () => {
    expect(() => httpAuthFrom({})).toThrow(/YEA_HTTP_TOKEN/);
    expect(() => httpAuthFrom({ YEA_HTTP_TOKEN: 'short' })).toThrow(
      /at least 32/,
    );
    expect(() => httpAuthFrom({ YEA_HTTP_TOKEN: TOKEN })).toThrow(/YEA_SUB/);
    expect(httpAuthFrom({ YEA_HTTP_TOKEN: TOKEN, YEA_SUB: 'me' })).toEqual({
      token: TOKEN,
      sub: 'me',
    });
  });

  it('refuses a request without the token, or with the wrong one, before MCP sees it', async () => {
    const { app } = await httpWorld();

    const tries: Record<string, string>[] = [
      {},
      { authorization: 'Bearer nope' },
      { authorization: TOKEN },
    ];

    for (const auth of tries) {
      const r = await app(post({ host: 'localhost', ...auth }));

      expect(r.status).toBe(401);
    }
  });

  it('on loopback, refuses another Host (DNS rebinding)', async () => {
    const { app } = await httpWorld();
    const r = await app(
      post({ host: 'evil.example', authorization: `Bearer ${TOKEN}` }),
    );

    expect(r.status).toBe(403);
  });

  it('serves the person with the token: jobs run as their sub', async () => {
    const { w, stripe, app } = await httpWorld();

    await suggestedGrant(w);

    const server = await serveHttp(app, { port: 0, host: '127.0.0.1' });
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
