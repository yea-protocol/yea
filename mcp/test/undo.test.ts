import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { yea } from '../src/index.js';
import {
  connect,
  grantPolicy,
  type Kind,
  refundJob,
  refundServer,
  textOf,
  world,
} from './helpers.js';

afterEach(() => {
  vi.useRealTimers();
  delete process.env.YEA_HOME;
});

const ch1 = { charge: 'ch_1' };

/** Run the refund once under a policy, and return its receipt id. */
async function refunded(conn: Awaited<ReturnType<typeof connect>>) {
  const r = await conn.call(ch1);

  expect(r.isError).toBeFalsy();

  return (r.structuredContent as { receipt: { id: string } }).receipt.id;
}

describe.each<Kind>(['2026', '2025'])('undo on a %s client', (kind) => {
  it('undoes within the window, once', async () => {
    const w = await world();

    await grantPolicy(w);

    const conn = await connect(kind, refundServer(w));
    const id = await refunded(conn);
    const r = await conn.call({ receipt: id }, 'undo');

    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toBe(`↶ undid ${id}: Refund 20.00 USD of ch_1`);
    expect(w.reverted).toEqual([ch1]);

    const again = await conn.call({ receipt: id }, 'undo');

    expect(again.isError).toBe(true);
    expect(textOf(again)).toMatch(/already undone/);
    expect(w.reverted).toHaveLength(1);
  });

  it('refuses after the window', async () => {
    const w = await world();

    await grantPolicy(w);

    const conn = await connect(kind, refundServer(w));
    const id = await refunded(conn);

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 3601 * 1000);

    const r = await conn.call({ receipt: id }, 'undo');

    expect(textOf(r)).toMatch(/the undo window has closed/);
    expect(w.reverted).toEqual([]);
  });

  it('refuses another sub', async () => {
    let who = 'ana';
    const w = await world({ sub: () => who });

    await grantPolicy(w);

    const conn = await connect(kind, refundServer(w));
    const id = await refunded(conn);

    who = 'ben';
    expect(textOf(await conn.call({ receipt: id }, 'undo'))).toMatch(
      /no such receipt/,
    );
    expect(w.reverted).toEqual([]);
  });

  it('refuses a receipt from another server sharing the store', async () => {
    const w = await world();

    await grantPolicy(w);

    const conn = await connect(kind, refundServer(w));
    const id = await refunded(conn);
    const other = yea({
      name: 'other',
      transport: 'stdio',
      store: w.store,
      serverKey: join(w.home, 'other.key'),
      principal: w.principal.public,
    });
    const elsewhere = await connect(kind, () => {
      const server = new McpServer(
        { name: 'other', version: '1' },
        other.serverOptions(),
      );

      other.job(server, 'refund', refundJob(w));

      return server;
    });

    expect(textOf(await elsewhere.call({ receipt: id }, 'undo'))).toMatch(
      /no such receipt/,
    );
    expect(w.reverted).toEqual([]);
  });

  it('a failed revert says so, and can be tried again', async () => {
    const w = await world();
    let fail = true;

    await grantPolicy(w);

    const conn = await connect(
      kind,
      refundServer(w, {
        revert: ({ input }) => {
          if (fail) {
            throw new Error('api down');
          }

          w.reverted.push(input);
        },
      }),
    );
    const id = await refunded(conn);
    const r = await conn.call({ receipt: id }, 'undo');

    expect(textOf(r)).toMatch(/undo failed: api down; nothing was undone/);
    fail = false;
    expect((await conn.call({ receipt: id }, 'undo')).isError).toBeFalsy();
    expect(w.reverted).toEqual([ch1]);
  });
});

it('an irreversible job has no undo, and its receipt says so', async () => {
  const w = await world();
  const conn = await connect('2025', refundServer(w, { revert: undefined }));

  conn.answers.push({ action: 'accept', content: { confirm: 'ch_1' } });

  const r = await conn.call(ch1);

  expect(textOf(r)).toMatch(/· irreversible/);

  const { tools } = await conn.client.listTools();

  expect(tools.map((t) => t.name)).toEqual(['refund']);
});

it('a job with revert on a server that already has its own undo tool is refused before registering', async () => {
  const w = await world();
  const server = new McpServer({ name: 'b', version: '1' });

  server.registerTool('undo', {}, () => ({ content: [] }));
  expect(() => w.approvals.job(server, 'refund', refundJob(w))).toThrow(
    /already has a tool named undo/,
  );

  const { tools } = await connectedTools(server);

  expect(tools.map((t) => t.name)).toEqual(['undo']);
});

async function connectedTools(server: McpServer) {
  const { InMemoryTransport } = await import('@modelcontextprotocol/server');
  const { Client } = await import('@modelcontextprotocol/client');
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'c', version: '1' });

  await server.connect(st);
  await client.connect(ct);

  return client.listTools();
}
