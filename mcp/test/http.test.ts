/** `@yea-protocol/mcp/http`: the bearer token, the Host check and the body cap, before MCP. */
import type { Server } from 'node:http';
import net, { type AddressInfo } from 'node:net';
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
  httpGate,
  MAX_BODY,
  subOf,
} from '../src/http.js';
import { type ServeHttpOptions, serveHttp } from '../src/http-node.js';

const TOKEN = 't'.repeat(40);

const GATE = httpGate({ token: TOKEN, loopback: true });

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

/** Serve `app` with the gate; the URL, and the server's sockets (to see how much it read). */
async function listening(
  app: (req: Request) => Promise<Response>,
  o: Partial<ServeHttpOptions> = {},
) {
  const server = await serveHttp(app, {
    port: 0,
    host: '127.0.0.1',
    gate: GATE,
    ...o,
  });
  const sockets: net.Socket[] = [];

  server.on('connection', (s) => sockets.push(s));
  servers.push(server);

  const { port } = server.address() as AddressInfo;

  return { url: `http://127.0.0.1:${port}/mcp`, port, sockets };
}

/**
 * Talk raw HTTP to `port`: send `head` and `body`, and collect the answer until it carries the
 * 401's `invalid_token`, or for 2 s (so a server still waiting for the body fails the test).
 */
const raw = (port: number, o: { head: string; body?: Buffer }) =>
  new Promise<string>((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    let got = '';
    const finish = () => {
      s.destroy();
      resolve(got);
    };
    const timer = setTimeout(finish, 2000);

    s.on('error', () => {});
    s.on('data', (c) => {
      got += c.toString();

      if (got.includes('invalid_token')) {
        clearTimeout(timer);
        finish();
      }
    });
    s.write(o.head);

    if (o.body) {
      s.write(o.body);
    }
  });

/** A body of `n` bytes, streamed in 64 KiB chunks (no Content-Length). */
function streamOf(n: number) {
  let sent = 0;

  return new ReadableStream({
    pull(c) {
      if (sent >= n) {
        c.close();

        return;
      }

      sent += 1 << 16;
      c.enqueue(new Uint8Array(1 << 16));
    },
  });
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

    expect(r.status).toBe(421);
    expect(await r.json()).toMatchObject({
      error: { message: 'Invalid Host: evil.example' },
    });
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

    expect(r.status).not.toBe(421);
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

describe('httpGate', () => {
  it('lets the token through on a loopback Host, and nothing else', () => {
    const req = (headers: Record<string, string>) =>
      new Request('http://localhost/mcp', { method: 'POST', headers });

    expect(
      GATE(req({ host: 'localhost:8787', authorization: `Bearer ${TOKEN}` })),
    ).toBeUndefined();
    expect(GATE(req({ host: 'localhost' }))?.status).toBe(401);
    expect(
      GATE(req({ host: 'evil.example', authorization: `Bearer ${TOKEN}` }))
        ?.status,
    ).toBe(421);
    expect(GATE(req({ authorization: `Bearer ${TOKEN}` }))?.status).toBe(421);
  });
});

describe('serveHttp', () => {
  it('serves the person with the token: calls run as their sub', async () => {
    const { app } = whoami();
    const { url } = await listening(app);
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

  it('answers 413 to a body over the cap, declared or streamed, however big, and the app never runs', async () => {
    const { app, seen } = whoami();
    const { url } = await listening(app);
    const headers = {
      'content-type': 'application/json',
      authorization: `Bearer ${TOKEN}`,
    };
    // Bigger than the cap plus what the server drains after refusing: it hangs up mid-upload.
    const huge = MAX_BODY + (4 << 20);
    const declared = await fetch(url, {
      method: 'POST',
      headers,
      body: 'x'.repeat(huge),
    });
    const streamed = await fetch(url, {
      method: 'POST',
      headers,
      duplex: 'half',
      body: streamOf(huge),
    } as RequestInit);
    const justOver = await fetch(url, {
      method: 'POST',
      headers,
      body: 'x'.repeat(MAX_BODY + 10),
    });

    expect(declared.status).toBe(413);
    expect(await declared.text()).toBe('request body exceeds 1 MiB');
    expect(streamed.status).toBe(413);
    expect(await streamed.text()).toBe('request body exceeds 1 MiB');
    expect(justOver.status).toBe(413);
    expect(await justOver.text()).toBe('request body exceeds 1 MiB');
    expect(seen.requests).toBe(0);
  });

  it('refuses a request without the token before reading its body', async () => {
    const { app, seen } = whoami();
    const { url, port, sockets } = await listening(app);
    const tenMiB = 10 << 20;
    // Declare 512 KiB (under the cap), send 16 KiB of it: the 401 comes without the rest. A
    // server that read the body before checking the token would still be waiting.
    const answer = await raw(port, {
      head: `POST /mcp HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: ${512 << 10}\r\n\r\n`,
      body: Buffer.alloc(16 << 10).fill('x'),
    });

    expect(answer).toMatch(/^HTTP\/1\.1 401 /);
    expect(answer).toMatch(/content-length: \d+/i);
    expect(sockets[0].bytesRead).toBeLessThan(64 << 10);

    // Expect: 100-continue without the token: 401, and never the go-ahead to send the body.
    const noContinue = await raw(port, {
      head: 'POST /mcp HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nExpect: 100-continue\r\nContent-Length: 1000\r\n\r\n',
    });

    expect(noContinue).toMatch(/^HTTP\/1\.1 401 /);
    expect(noContinue).not.toMatch(/100 Continue/);
    expect(sockets[1].bytesRead).toBeLessThan(1000);

    // A client that sends the whole 10 MiB still reads the 401.
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'x'.repeat(tenMiB),
    });

    expect(r.status).toBe(401);
    expect(await r.text()).toMatch(/invalid_token/);
    expect(seen.requests).toBe(0);
  });

  it('takes a smaller cap, and still checks the token under it', async () => {
    const { app, seen } = whoami();
    const { url } = await listening(app, { maxBody: 1000 });
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
    expect(seen.requests).toBe(0);
  });

  it('cuts off a client that takes too long to send its request', async () => {
    const { app, seen } = whoami();
    const { port } = await listening(app, { requestTimeout: 200 });
    const closed = await new Promise<string>((resolve) => {
      const s = net.connect(port, '127.0.0.1');
      let got = '';

      s.on('error', () => {});
      s.on('data', (c) => {
        got += c.toString();
      });
      s.on('close', () => resolve(got));
      s.write(
        `POST /mcp HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${TOKEN}\r\nContent-Length: 100\r\n\r\n{`,
      );
    });

    expect(closed).toMatch(/^(HTTP\/1\.1 408 |$)/);
    expect(seen.requests).toBe(0);
  });
});
