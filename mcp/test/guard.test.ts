import {
  type CallToolResult,
  McpServer,
  type RegisteredTool,
} from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';
import * as z from 'zod';
import type { GuardConfig } from '../src/index.js';
import {
  approve,
  connect,
  type Kind,
  textOf,
  type World,
  world,
} from './helpers.js';

afterEach(() => {
  delete process.env.YEA_HOME;
});

interface Counter {
  charged: string[];
}

/** An existing tool, registered by code the author didn't change. */
function registerCharge(server: McpServer, c: Counter): RegisteredTool {
  return server.registerTool(
    'charge',
    {
      description: 'Charge a card',
      inputSchema: z.object({ amount: z.string() }),
      outputSchema: z.object({ charged: z.string() }),
    },
    ({ amount }): CallToolResult => {
      c.charged.push(amount);

      return {
        content: [{ type: 'text', text: `charged ${amount}` }],
        structuredContent: { charged: amount },
      };
    },
  );
}

const describeCharge: GuardConfig = {
  describe: ({ amount }) => ({
    summary: `Charge ${String(amount)} USD`,
    effects: [
      { op: 'create', target: 'charge', detail: `${String(amount)} USD` },
    ],
    risk: 'low',
  }),
};

function guarded(
  w: Pick<World, 'approvals'>,
  c: Counter,
  config = describeCharge,
) {
  return () => {
    const server = new McpServer(
      { name: 'billing', version: '1' },
      w.approvals.serverOptions(),
    );

    w.approvals.guard(server, registerCharge(server, c), config);

    return server;
  };
}

describe.each<Kind>(['2026', '2025'])('guard on a %s client', (kind) => {
  it('runs the original only once approved; its result and outputSchema pass through', async () => {
    const w = await world();
    const c: Counter = { charged: [] };
    const conn = await connect(kind, guarded(w, c));

    // Cache the tool list, so the client validates results against the outputSchema.
    await conn.client.listTools();
    conn.answers.push({ action: 'decline' });
    expect((await conn.call({ amount: '5' }, 'charge')).isError).toBe(true);
    expect(c.charged).toEqual([]);

    conn.answers.push({ action: 'accept', content: { confirm: 'approve' } });

    const r = await conn.call({ amount: '5' }, 'charge');

    expect(r.isError).toBeFalsy();
    expect(c.charged).toEqual(['5']);
    expect(r.structuredContent).toEqual({ charged: '5' });
    expect(textOf(r)).toBe('charged 5');
    expect(r._meta?.['dev.yea/receipt']).toMatchObject({
      tool: 'charge',
      input: { amount: '5' },
      undo: null,
    });
  });

  it('a preview through a tool with an outputSchema reaches the client as isError', async () => {
    const w = await world();
    const c: Counter = { charged: [] };
    const conn = await connect(kind, guarded(w, c));

    await conn.client.listTools();

    const r = await conn.call({ amount: '5', preview: true }, 'charge');

    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/^preview: nothing was run/);
    expect(c.charged).toEqual([]);
  });

  it('lists the guarded tool with preview and job metadata', async () => {
    const w = await world();
    const conn = await connect(kind, guarded(w, { charged: [] }));
    const { tools } = await conn.client.listTools();
    const tool = tools.find((t) => t.name === 'charge');

    expect(tool?.inputSchema.properties).toHaveProperty('preview');
    expect(tool?._meta?.['dev.yea/job']).toEqual({
      risk: 'medium',
      undoable: false,
    });
    expect(tool?.annotations?.destructiveHint).toBe(true);
  });
});

describe.each<Kind>(['2026-no-elicit', '2025-no-elicit'])(
  'guard on a %s client',
  (kind) => {
    it('a consent-code result through a tool with an outputSchema reaches the client as isError', async () => {
      const w = await world();
      const c: Counter = { charged: [] };
      const conn = await connect(kind, guarded(w, c));

      await conn.client.listTools();

      const r = await conn.call({ amount: '5' }, 'charge');

      expect(r.isError).toBe(true);
      expect(textOf(r)).toMatch(/yea approve <code>/);

      const { codes } = r.structuredContent as { codes: { code: string }[] };

      await approve(w, codes[0].code);

      const ran = await conn.call({ amount: '5' }, 'charge');

      expect(ran.isError).toBeFalsy();
      expect(ran.structuredContent).toEqual({ charged: '5' });
      expect(c.charged).toEqual(['5']);
    });
  },
);

describe('guard failures', () => {
  it('an original that returns isError counts as a failure: no receipt, returned as is', async () => {
    const w = await world();
    const conn = await connect('2025', () => {
      const server = new McpServer(
        { name: 'b', version: '1' },
        w.approvals.serverOptions(),
      );
      const tool = server.registerTool(
        'charge',
        { inputSchema: z.object({ amount: z.string() }) },
        () => ({
          content: [{ type: 'text', text: 'card declined' }],
          isError: true,
        }),
      );

      w.approvals.guard(server, tool, describeCharge);

      return server;
    });

    conn.answers.push({ action: 'accept', content: { confirm: 'approve' } });

    const r = await conn.call({ amount: '5' }, 'charge');

    expect(r).toMatchObject({
      isError: true,
      content: [{ text: 'card declined' }],
    });
    expect(r._meta?.['dev.yea/receipt']).toBeUndefined();
  });

  it('a failed update leaves the tool disabled', () => {
    const server = new McpServer({ name: 'b', version: '1' });
    const tool = server.registerTool(
      'charge',
      { inputSchema: z.object({ amount: z.string(), preview: z.boolean() }) },
      () => ({ content: [] }),
    );

    return world().then((w) => {
      expect(() => w.approvals.guard(server, tool, describeCharge)).toThrow(
        /field named preview/,
      );
      expect(tool.enabled).toBe(false);

      const other = server.registerTool(
        'refund',
        { inputSchema: z.object({ amount: z.string() }) },
        () => ({ content: [] }),
      );

      const update = other.update.bind(other);

      // disable() goes through update(); only the handler swap fails.
      other.update = (u) => {
        if (u.callback) {
          throw new Error('update failed');
        }

        update(u);
      };
      expect(() => w.approvals.guard(server, other, describeCharge)).toThrow(
        'update failed',
      );
      expect(other.enabled).toBe(false);
    });
  });

  it('refuses a tool registered on another server', async () => {
    const w = await world();
    const a = new McpServer({ name: 'a', version: '1' });
    const b = new McpServer({ name: 'b', version: '1' });
    const tool = registerCharge(a, { charged: [] });

    expect(() => w.approvals.guard(b, tool, describeCharge)).toThrow(
      /not registered on this server/,
    );
  });

  it('a tool without a schema keeps the cb(ctx) form', async () => {
    const w = await world();
    let pinged = 0;
    const conn = await connect('2025', () => {
      const server = new McpServer(
        { name: 'b', version: '1' },
        w.approvals.serverOptions(),
      );
      const tool = server.registerTool('ping', {}, () => {
        pinged++;

        return { content: [{ type: 'text', text: 'pong' }] };
      });

      w.approvals.guard(server, tool, {
        describe: () => ({ summary: 'Ping', effects: [] }),
      });

      return server;
    });

    conn.answers.push({ action: 'accept', content: { confirm: 'approve' } });
    expect(textOf(await conn.call({}, 'ping'))).toBe('pong');
    expect(pinged).toBe(1);
  });
});
