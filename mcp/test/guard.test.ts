import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  type CallToolResult,
  McpServer,
  type RegisteredTool,
} from '@modelcontextprotocol/server';
import { exact, quantity } from '@yea-protocol/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import * as z from 'zod';
import type { GuardConfig } from '../src/index.js';
import {
  approve,
  connect,
  grantPolicy,
  type Kind,
  ledgerKeyOf,
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

  // #150: the original's result used to be replaced by the line; now it's kept, as in mcp-py.
  it('a guarded tool keeps its own result when its receipt can’t be saved, with the line appended', async () => {
    const w = await world();
    const c: Counter = { charged: [] };
    const conn = await connect('2025', guarded(w, c));

    w.store.putReceipt = () => Promise.reject(new Error('disk full'));
    // Cache the tool list, so the client validates the kept result against the outputSchema.
    await conn.client.listTools();
    conn.answers.push({ action: 'accept', content: { confirm: 'approve' } });

    const r = await conn.call({ amount: '5' }, 'charge');

    expect(c.charged).toEqual(['5']);
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toEqual({ charged: '5' });
    expect(r.content).toEqual([
      { type: 'text', text: 'charged 5' },
      {
        type: 'text',
        text: "✓ Charge 5 USD happened, but then disk full; its receipt wasn't saved, so it can't be undone.",
      },
    ]);
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

describe('guard refuses schemas it can’t carry preview on', () => {
  it('throws for a preview property or a root that isn’t a plain object, and leaves the tool off', async () => {
    const w = await world();
    const server = new McpServer({ name: 'b', version: '1' });
    const schemas = {
      withPreview: z.object({ amount: z.string(), preview: z.string() }),
      union: z.union([
        z.object({ a: z.string() }),
        z.object({ b: z.string() }),
      ]),
      string: z.string(),
    };

    for (const [name, inputSchema] of Object.entries(schemas)) {
      const tool = server.registerTool(
        name,
        { inputSchema: inputSchema as z.ZodObject },
        () => ({ content: [] }),
      );

      expect(() => w.approvals.guard(server, tool, describeCharge)).toThrow(
        /^guard\(\): a job input schema (may not have a field named preview|must be a plain object at its root)/,
      );
      expect(tool.enabled).toBe(false);
    }
  });
});

describe('guard failure detection reads the value the original returned', () => {
  /**
   * A guarded tool (no outputSchema) that auto-runs under a policy with a total, and returns
   * `result`; `before` can break the store first.
   */
  async function autoRun(
    result: Record<string, unknown>,
    before: (w: World) => void = () => undefined,
  ) {
    const w = await world();

    before(w);

    const token = await grantPolicy(w, [
      { can: ['charge'] },
      { risk: 'low' },
      { total: { of: 'emails', max: 5 } },
    ]);
    let calls = 0;
    const conn = await connect('2026', () => {
      const server = new McpServer(
        { name: 'b', version: '1' },
        w.approvals.serverOptions(),
      );
      const tool = server.registerTool(
        'charge',
        { inputSchema: z.object({ amount: z.string() }) },
        () => {
          calls++;

          return result as never;
        },
      );

      w.approvals.guard(server, tool, {
        describe: () => ({
          summary: 'Charge',
          effects: [],
          risk: 'low',
          uses: { emails: quantity(1) },
          undoWindow: 60,
        }),
        revert: () => null,
      });

      return server;
    });
    const r = await conn.raw({ name: 'charge', arguments: { amount: '5' } });

    return { w, token, r, calls: () => calls };
  }

  it('a plain { content, isError: true }: passed through, no receipt, reservations released', async () => {
    const failed = {
      content: [{ type: 'text', text: 'card declined' }],
      isError: true,
    };
    const { w, token, r, calls } = await autoRun(failed);

    expect(calls()).toBe(1);
    expect(r).toMatchObject(failed);
    expect(r._meta).not.toHaveProperty('dev.yea/receipt');
    expect(filesIn(w.storeDir, 'receipts')).toEqual([]);
    expect(await w.store.used(await ledgerKeyOf(token))).toBe(0n);
  });

  it('an input_required result: passed through, no receipt, reservations released', async () => {
    const asks = { resultType: 'input_required', requestState: 'inner' };
    const { w, token, r, calls } = await autoRun(asks);

    expect(calls()).toBe(1);
    expect(r).toMatchObject(asks);
    expect(filesIn(w.storeDir, 'receipts')).toEqual([]);
    expect(await w.store.used(await ledgerKeyOf(token))).toBe(0n);
  });

  it('a success is settled and gets a receipt', async () => {
    const ok = { content: [{ type: 'text', text: 'charged' }] };
    const { w, token, r } = await autoRun(ok);

    expect(r._meta).toHaveProperty('dev.yea/receipt');
    expect(filesIn(w.storeDir, 'receipts')).toHaveLength(1);
    expect(await w.store.used(await ledgerKeyOf(token))).toBe(
      exact(quantity(1)),
    );
  });

  // #150: as in mcp-py, the original's result is kept with the line appended, whichever step fails.
  it.each(['settle', 'putReceipt'] as const)(
    'a %s failure after apply keeps the original result and appends the line',
    async (step) => {
      const ok = { content: [{ type: 'text', text: 'charged' }] };
      const { r, calls } = await autoRun(ok, (w) => {
        w.store[step] = () => Promise.reject(new Error('disk full'));
      });

      expect(calls()).toBe(1);
      expect(r.isError).toBeFalsy();
      expect(r.content).toEqual([
        { type: 'text', text: 'charged' },
        {
          type: 'text',
          text: "✓ Charge happened, but then disk full; its receipt wasn't saved, so it can't be undone.",
        },
      ]);
    },
  );
});

const filesIn = (root: string, dir: string) =>
  existsSync(join(root, dir)) ? readdirSync(join(root, dir)) : [];

describe('guard refuses what is already a job', () => {
  it('a tool it already guarded, or a job() tool, is refused and left as it was', async () => {
    const w = await world();
    const server = new McpServer({ name: 'b', version: '1' });
    const tool = registerCharge(server, { charged: [] });

    w.approvals.guard(server, tool, describeCharge);

    const handler = tool.handler;

    expect(() => w.approvals.guard(server, tool, describeCharge)).toThrow(
      /charge is already a job tool/,
    );
    expect(tool.handler).toBe(handler);
    expect(tool.enabled).toBe(true);

    const job = w.approvals.job(server, 'refund', {
      inputSchema: z.object({ charge: z.string() }),
      plan: () => [],
    });

    expect(() => w.approvals.guard(server, job, describeCharge)).toThrow(
      /refund is already a job tool/,
    );
  });

  it('takes the tool’s risk for its metadata and as the plans’ default', async () => {
    const w = await world();
    const conn = await connect(
      '2025',
      guarded(
        w,
        { charged: [] },
        {
          risk: 'high',
          describe: () => ({ summary: 'Charge', effects: [] }),
        },
      ),
    );
    const { tools } = await conn.client.listTools();

    expect(tools[0]._meta?.['dev.yea/job']).toEqual({
      risk: 'high',
      undoable: false,
    });

    const preview = await conn.call({ amount: '5', preview: true }, 'charge');

    expect(preview.structuredContent).toMatchObject({
      plans: [{ risk: 'high' }],
    });
  });
});
