import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequestStateCodec } from '@modelcontextprotocol/server';
import { exact, quantity } from '@yea-protocol/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import {
  approve,
  connect,
  grantPolicy,
  type Kind,
  ledgerKeyOf,
  refundServer,
  textOf,
  world,
} from './helpers.js';

afterEach(() => {
  delete process.env.YEA_HOME;
});

const ch1 = { charge: 'ch_1' };
const accept = (confirm: string) => ({
  action: 'accept' as const,
  content: { confirm },
});

/** Every file under a directory, or none if it doesn't exist. */
const filesUnder = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((d) => d.isFile())
        .map((d) => d.name)
    : [];

describe.each<Kind>(['2026', '2025'])('a %s client that can elicit', (kind) => {
  it('runs a job the policy allows once, with a receipt, reserving and settling its total', async () => {
    const w = await world();
    const token = await grantPolicy(w);
    const conn = await connect(kind, refundServer(w));
    const r = await conn.call(ch1);

    expect(r.isError).toBeFalsy();
    expect(w.applied).toEqual(['ch_1']);
    expect(conn.elicited).toHaveLength(0);
    expect(textOf(r)).toMatch(/^✓ Refund 20.00 USD of ch_1 \(receipt r_/);

    const { receipt, result } = r.structuredContent as {
      receipt: { id: string; undo: { until: number }; sub: string };
      result: unknown;
    };

    expect(result).toEqual({ refunded: 'ch_1' });
    expect(await w.store.getReceipt(receipt.id)).toMatchObject({
      tool: 'refund',
      input: ch1,
      sub: '',
    });

    const key = await ledgerKeyOf(token);

    expect(await w.store.used(key)).toBe(exact(quantity(1)));

    // Settled, not left reserved.
    const ledger = JSON.parse(
      readFileSync(
        join(w.storeDir, 'ledger', key.block, 'emails.json'),
        'utf8',
      ),
    );

    expect(ledger).toEqual({
      settled: String(exact(quantity(1))),
      reserved: {},
    });

    // The total holds: two emails, then the third asks.
    await conn.call({ charge: 'ch_2' });
    conn.answers.push({ action: 'decline' });
    expect(textOf(await conn.call({ charge: 'ch_3' }))).toMatch(/not approved/);
    expect(w.applied).toEqual(['ch_1', 'ch_2']);
  });

  it('asks outside the policy; typing the phrase runs it', async () => {
    const w = await world();
    const conn = await connect(kind, refundServer(w));

    conn.answers.push(accept(' CH_1 '));

    const r = await conn.call(ch1);

    expect(r.isError).toBeFalsy();
    expect(w.applied).toEqual(['ch_1']);
    expect(conn.elicited).toHaveLength(1);
    expect(conn.elicited[0].message).toMatch(
      /Approval needed: no signed policy lets refund run without asking/,
    );
    expect(conn.elicited[0].requestedSchema).toMatchObject({
      properties: { confirm: { description: 'Type "ch_1" to approve.' } },
      required: ['confirm'],
    });
  });

  it('a wrong phrase asks again, and the third wrong one refuses', async () => {
    const w = await world();
    const conn = await connect(kind, refundServer(w));

    conn.answers.push(accept('ch_2'), accept('approve'), accept(''));

    const r = await conn.call(ch1);

    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/not approved after 3 tries/);
    expect(conn.elicited).toHaveLength(3);
    expect(conn.elicited[1].message).toMatch(/type "ch_1" exactly to approve/);
    expect(w.applied).toEqual([]);
  });

  it('a wrong phrase then the right one runs, once', async () => {
    const w = await world();
    const conn = await connect(kind, refundServer(w));

    conn.answers.push(accept('nope'), accept('ch_1'));
    expect((await conn.call(ch1)).isError).toBeFalsy();
    expect(w.applied).toEqual(['ch_1']);
  });

  it.each(['decline', 'cancel'] as const)('%s runs nothing', async (action) => {
    const w = await world();
    const conn = await connect(kind, refundServer(w));

    conn.answers.push({ action });

    const r = await conn.call(ch1);

    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/not approved; nothing was run/);
    expect(w.applied).toEqual([]);
  });

  it('the same state sent twice runs nothing the second time', async () => {
    const w = await world();
    const seen: string[] = [];
    const conn = await connect(kind, refundServer(w, {}, { seen }));

    conn.answers.push(accept('ch_1'));
    expect((await conn.call(ch1)).isError).toBeFalsy();
    expect(seen).toHaveLength(1);

    const again = await conn.raw({
      name: 'refund',
      arguments: ch1,
      requestState: seen[0],
      inputResponses: { yea: accept('ch_1') },
    });

    expect(again.isError).toBe(true);
    expect(textOf(again)).toMatch(/invalid, expired, already used/);
    expect(w.applied).toEqual(['ch_1']);
  });

  it('offers a choice of plans, and runs the one chosen', async () => {
    const w = await world();
    const conn = await connect(
      kind,
      refundServer(w, {
        plan: ({ charge }) =>
          ['full', 'half'].map((how) => ({
            summary: `Refund ${how} of ${charge}`,
            effects: [{ op: 'create', target: 'refund', detail: how }],
            apply: () => {
              w.applied.push(`${how} ${charge}`);
            },
          })),
        confirmWith: (hp) => hp.plan.summary.split(' ')[1],
      }),
    );

    conn.answers.push(async () => {
      const schema = conn.elicited[0].requestedSchema as {
        properties: { plan: { oneOf: { const: string; title: string }[] } };
      };
      const half = schema.properties.plan.oneOf.find((o) =>
        o.title.startsWith('Refund half'),
      );

      return {
        action: 'accept',
        content: { plan: half?.const, confirm: 'half' },
      };
    });

    expect((await conn.call(ch1)).isError).toBeFalsy();
    expect(w.applied).toEqual(['half ch_1']);
  });
});

describe('a missing answer runs nothing', () => {
  it('2026: a retry with the state but no answer is not an approval, and the state is used up', async () => {
    const w = await world();
    const conn = await connect('2026', refundServer(w));
    const first = await conn.raw({ name: 'refund', arguments: ch1 });

    expect(first.resultType).toBe('input_required');

    const retry = {
      name: 'refund',
      arguments: ch1,
      requestState: first.requestState,
    };

    expect(textOf(await conn.raw(retry))).toMatch(/not approved/);
    expect(
      textOf(
        await conn.raw({ ...retry, inputResponses: { yea: accept('ch_1') } }),
      ),
    ).toMatch(/already used/);
    expect(w.applied).toEqual([]);
  });

  it('2025: a raw retry that beats the shim consumes the state, so the answer runs nothing', async () => {
    const minted: string[] = [];
    const base = createRequestStateCodec<unknown>({
      key: new Uint8Array(32).fill(7),
      bind: (ctx) => `${ctx.mcpReq.method}\0`,
    });
    const codec = {
      verify: base.verify,
      mint: async (p: unknown, ctx?: Parameters<typeof base.mint>[1]) => {
        const s = await base.mint(p, ctx);

        minted.push(s);

        return s;
      },
    };
    const w = await world({ codec });
    const conn = await connect('2025', refundServer(w));
    let missing = '';

    conn.answers.push(async () => {
      missing = textOf(
        await conn.raw({
          name: 'refund',
          arguments: ch1,
          requestState: minted[0],
        }),
      );

      return accept('ch_1');
    });

    const r = await conn.call(ch1);

    expect(missing).toMatch(/not approved/);
    expect(textOf(r)).toMatch(/already used/);
    expect(w.applied).toEqual([]);
  });
});

describe.each<Kind>(['2026-no-elicit', '2025-no-elicit', 'legacy-http'])(
  'a %s client that can’t ask',
  (kind) => {
    it('gets consent codes; after yea approve the next call runs, once', async () => {
      const w = await world();
      const conn = await connect(kind, refundServer(w));
      const r = await conn.call(ch1);

      expect(r.isError).toBe(true);
      expect(textOf(r)).toMatch(
        /Ask the user to run `yea approve <code>` in their terminal, then call again/,
      );
      expect(w.applied).toEqual([]);

      const { codes } = r.structuredContent as { codes: { code: string }[] };

      expect(codes).toHaveLength(1);

      const j = await approve(w, codes[0].code);

      expect(j.phrase).toBe('ch_1');
      expect((await conn.call(ch1)).isError).toBeFalsy();
      expect(w.applied).toEqual(['ch_1']);

      const third = await conn.call(ch1);

      expect(third.isError).toBe(true);
      expect(w.applied).toEqual(['ch_1']);
    });

    it('still runs what the policy allows', async () => {
      const w = await world();

      await grantPolicy(w);

      const conn = await connect(kind, refundServer(w));

      expect((await conn.call(ch1)).isError).toBeFalsy();
      expect(w.applied).toEqual(['ch_1']);
    });
  },
);

describe.each<Kind>(['2026', '2025'])('preview on a %s client', (kind) => {
  it('runs nothing and stores nothing', async () => {
    const w = await world();

    await grantPolicy(w);

    const conn = await connect(kind, refundServer(w));
    const r = await conn.call({ ...ch1, preview: true });

    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toMatch(
      /^preview: nothing was run\n1 plan:\n\[1\] Refund 20.00 USD/,
    );
    expect(r.structuredContent).toMatchObject({
      plans: [
        {
          summary: 'Refund 20.00 USD of ch_1',
          risk: 'low',
          undo: { window: 3600 },
        },
      ],
    });
    expect(w.applied).toEqual([]);
    expect(conn.elicited).toEqual([]);
    expect(filesUnder(w.storeDir)).toEqual([]);
  });

  it('a denied tool doesn’t even preview, and its plan() never runs', async () => {
    const w = await world({ tighten: { deny: ['refund'] } });
    let planned = 0;
    const conn = await connect(
      kind,
      refundServer(w, {
        plan: () => {
          planned++;

          return [];
        },
      }),
    );

    for (const args of [{ ...ch1, preview: true }, ch1]) {
      const r = await conn.call(args);

      expect(r.isError).toBe(true);
      expect(textOf(r)).toMatch(/your policy never allows refund/);
    }

    expect(planned).toBe(0);
  });

  it('a preview that isn’t a boolean is refused by the schema', async () => {
    const w = await world();
    const conn = await connect(kind, refundServer(w));
    const r = await conn.call({ ...ch1, preview: 'yes' });

    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/preview must be true or false/);
  });
});

describe('the tool as clients see it', () => {
  it('carries preview in its schema, job annotations and risk metadata', async () => {
    const w = await world();
    const conn = await connect('2026', refundServer(w));
    const { tools } = await conn.client.listTools();
    const refund = tools.find((t) => t.name === 'refund');
    const undo = tools.find((t) => t.name === 'undo');

    expect(refund?.inputSchema).toMatchObject({
      type: 'object',
      properties: { charge: { type: 'string' }, preview: { type: 'boolean' } },
      required: ['charge'],
    });
    expect(refund?.annotations).toEqual({
      readOnlyHint: false,
      idempotentHint: false,
      destructiveHint: true,
    });
    expect(refund?._meta?.['dev.yea/job']).toEqual({
      risk: 'low',
      undoable: true,
    });
    expect(undo?.annotations).toMatchObject({
      destructiveHint: true,
      idempotentHint: true,
    });
  });

  it('returns a clarification as text', async () => {
    const w = await world();
    const { clarify } = await import('@yea-protocol/sdk');
    const conn = await connect(
      '2025',
      refundServer(w, {
        plan: () =>
          clarify('Which charge?', [
            { label: 'The last one', params: { charge: 'ch_9' } },
          ]),
      }),
    );
    const r = await conn.call(ch1);

    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toBe('? Which charge?\n  1. The last one → charge: ch_9');
  });

  it('refuses non-integer numbers before planning', async () => {
    const w = await world();
    const { McpServer } = await import('@modelcontextprotocol/server');
    const z = await import('zod');
    let planned = 0;
    const conn = await connect('2025', () => {
      const server = new McpServer(
        { name: 'b', version: '1' },
        w.approvals.serverOptions(),
      );

      w.approvals.job(server, 'tip', {
        inputSchema: z.object({ amount: z.number() }),
        plan: () => {
          planned++;

          return [];
        },
      });

      return server;
    });
    const r = await conn.call({ amount: 1.5 }, 'tip');

    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(
      /input.amount is 1.5: job inputs can only hold safe integers/,
    );
    expect(planned).toBe(0);
  });

  it('says so plainly when an approved apply fails, and releases what it reserved', async () => {
    const w = await world();
    const token = await grantPolicy(w);
    const conn = await connect(
      '2025',
      refundServer(w, {
        plan: () => [
          {
            summary: 'Refund',
            effects: [],
            uses: { emails: quantity(1) },
            undoWindow: 60,
            apply: () => {
              throw new Error('card network down');
            },
          },
        ],
      }),
    );
    const r = await conn.call(ch1);

    expect(r.isError).toBe(true);
    expect(textOf(r)).toBe(
      '✗ Refund failed: card network down; nothing changed.',
    );
    expect(await w.store.used(await ledgerKeyOf(token))).toBe(0n);
  });
});

describe('with a MemoryStore and one process', () => {
  it('serves HTTP through createMcpHandler with a sub from the transport', async () => {
    const { MemoryStore } = await import('@yea-protocol/sdk');
    const w = await world({
      transport: 'http',
      store: new MemoryStore(),
      singleProcess: true,
      sub: () => 'person-1',
    });
    const conn = await connect('2026', refundServer(w));

    conn.answers.push(accept('ch_1'));

    const r = await conn.call(ch1);

    expect(r.isError).toBeFalsy();
    expect(
      (r.structuredContent as { receipt: { sub: string } }).receipt.sub,
    ).toBe('person-1');
  });
});

describe('a pinned principal key', () => {
  it('without one, nothing auto-runs and codes can’t be approved', async () => {
    const w = await world({ principal: undefined });

    await grantPolicy(w);

    const conn = await connect('2025-no-elicit', refundServer(w));
    const r = await conn.call(ch1);

    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(
      /No consent can be accepted: YEA_PRINCIPAL_PUB is not set/,
    );
    expect(w.applied).toEqual([]);
  });

  it('without one, the form still works', async () => {
    const w = await world({ principal: undefined });
    const conn = await connect('2025', refundServer(w));

    conn.answers.push(accept('ch_1'));
    expect((await conn.call(ch1)).isError).toBeFalsy();
  });
});
