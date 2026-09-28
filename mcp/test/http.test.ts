/** `@yea-protocol/mcp/http`: the bearer token, the Host check and the body cap, before MCP. */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { McpServer } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';
import * as z from 'zod';
import {
  httpApp,
  httpAuthFrom,
  MAX_BODY,
  serveHttp,
  subOf,
} from '../src/http.js';

const TOKEN = 't'.repeat(40);

const servers: Server[] = [];

afterEach(() => {
  for (const s of servers.splice(0)) {
    s.close();
  }
});

/** A server with one tool that says who is calling, and a count of the requests MCP saw. */
function whoami() {
  const seen = { requests: 0 };
  const factory = () => {
    const server = new McpServer({ name: 'who', version: '1' });

    server.registerTool(
      'whoami',
      { description: 'Who is calling', inputSchema: z.object({}) },
      (_args, ctx) => ({
        content: [{ type: 'text', text: subOf(ctx) }],
      }),
    );

    return server;
  };
  const inner = httpApp(factory, {
    token: TOKEN,
    sub: 'person-1',
    loopback: true,
  });
  const app = (req: Request) => {
    seen.requests++;

    return inner(req);
  };

  return { app, seen };
}

const post = (headers: Record<string, string>, body?: BodyInit) =>
  new Request('http://localhost/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body:
      body ?? JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });

async function listening(app: (req: Request) => Promise<Response>) {
  const server = await serveHttp(app, { port: 0, host: '127.0.0.1' });

  servers.push(server);

  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
}

describe('httpAuthFrom', () => {
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
});

describe('httpApp', () => {
  it('refuses a request without the token, or with the wrong one, before MCP sees it', async () => {
    const { app } = whoami();
    const tries: Record<string, string>[] = [
      {},
      { authorization: 'Bearer nope' },
      { authorization: TOKEN },
      { authorization: `Basic ${TOKEN}` },
    ];

    for (const auth of tries) {
      const r = await app(post({ host: 'localhost', ...auth }));

      expect(r.status).toBe(401);
      expect(r.headers.get('www-authenticate')).toBe('Bearer');
    }
  });

  it('on loopback, refuses another Host (DNS rebinding)', async () => {
    const { app } = whoami();
    const r = await app(
      post({ host: 'evil.example', authorization: `Bearer ${TOKEN}` }),
    );

    expect(r.status).toBe(403);
  });

  it('off loopback, leaves the Host alone', async () => {
    const factory = () => new McpServer({ name: 'x', version: '1' });
    const app = httpApp(factory, { token: TOKEN, sub: 'me', loopback: false });
    const r = await app(
      post({
        host: 'mcp.example',
        authorization: `Bearer ${TOKEN}`,
        accept: 'application/json, text/event-stream',
      }),
    );

    expect(r.status).not.toBe(403);
    expect(r.status).not.toBe(401);
  });

  it('caps the body the MCP handler reads, on any runtime', async () => {
    const { app } = whoami();
    const r = await app(
      post(
        { host: 'localhost', authorization: `Bearer ${TOKEN}` },
        'x'.repeat(MAX_BODY + 1),
      ),
    );

    expect(r.status).toBe(413);
  });
});

describe('serveHttp', () => {
  it('serves the person with the token: calls run as their sub', async () => {
    const { app } = whoami();
    const url = await listening(app);
    const client = new Client(
      { name: 'c', version: '1' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } },
    );

    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(url), {
          requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
        }),
      );

      const r = await client.callTool({ name: 'whoami', arguments: {} });

      expect(r.content).toEqual([{ type: 'text', text: 'person-1' }]);
    } finally {
      await client.close();
    }
  });

  it('answers 413 to a body over the cap, declared or streamed, and the app never runs', async () => {
    const { app, seen } = whoami();
    const url = await listening(app);
    const headers = {
      'content-type': 'application/json',
      authorization: `Bearer ${TOKEN}`,
    };
    const declared = await fetch(url, {
      method: 'POST',
      headers,
      body: 'x'.repeat(MAX_BODY + 10),
    });
    let sent = 0;
    const streamed = await fetch(url, {
      method: 'POST',
      headers,
      duplex: 'half',
      body: new ReadableStream({
        pull(c) {
          if (sent > MAX_BODY) {
            c.close();

            return;
          }

          sent += 1 << 16;
          c.enqueue(new Uint8Array(1 << 16));
        },
      }),
    } as RequestInit);

    expect(declared.status).toBe(413);
    expect(await declared.text()).toBe('request body exceeds 1 MiB');
    expect(streamed.status).toBe(413);
    expect(seen.requests).toBe(0);
  });

  it('takes a smaller cap, and still checks the token under it', async () => {
    const { app, seen } = whoami();
    const server = await serveHttp(app, {
      port: 0,
      host: '127.0.0.1',
      maxBody: 1000,
    });

    servers.push(server);

    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
    const big = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
      body: 'x'.repeat(1001),
    });
    const noToken = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });

    expect(big.status).toBe(413);
    expect(await big.text()).toBe('request body exceeds 1000 bytes');
    expect(noToken.status).toBe(401);
    expect(seen.requests).toBe(1);
  });
});
