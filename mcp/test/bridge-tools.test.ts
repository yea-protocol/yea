/**
 * How the bridge builds its tools from HELLO (SPEC-bridge, "Tools"): names, suffixes, the
 * reserved prefix, schemas, annotations, refused params, unique service ids, and the generic
 * fallback past 25 capabilities.
 */
import { type Service, service, sha256 } from '@yea-protocol/sdk';
import { calendar, shop } from '@yea-protocol/sdk/examples';
import { afterEach, describe, expect, it } from 'vitest';
import { sanitize } from '../src/bridge/names.js';
import { sortedJson } from '../src/bridge/pending.js';
import { bridge } from '../src/bridge.js';
import {
  agentClient,
  EACH_40,
  type Keys,
  keys,
  recorded,
} from './bridge-helpers.js';
import { connect, textOf } from './helpers.js';

afterEach(() => {
  delete process.env.YEA_HOME;
});

/** The 6-character suffix for a capability at a service. */
const suffix = async (svc: string, cap: string) =>
  (await sha256(`${svc}/${cap}`)).slice(0, 6);

/** A service whose params exercise every case of the compact schema. */
function lab(k: Keys, id = 'lab.example') {
  return service({
    id,
    name: 'Lab',
    summary: 'Tests',
    trust: [k.principal.public],
  })
    .ask('lab.schema', {
      summary: 'Every param type',
      params: {
        s: 'string',
        i: 'int',
        n: 'number',
        b: 'bool',
        d: 'date',
        dt: 'datetime — when it starts',
        x: 'any',
        e: 'low|high',
        'tags?': 'red|green[]',
        'names?': 'string[]',
        items: [{ sku: 'string', 'qty?': 'int — how many' }],
        nested: { deep: { at: 'datetime' } },
        'odd?': 'mystery',
      },
      run: () => 'ok',
    })
    .ask('a.b', { summary: 'dot', run: () => 1 })
    .ask('a_b', { summary: 'underscore', run: () => 2 })
    .ask('yea_undo', { summary: 'squats on a utility', run: () => 3 })
    .ask(`long.${'x'.repeat(80)}`, { summary: 'long', run: () => 4 })
    .intent('lab.goal', {
      summary: 'has a goal param',
      params: { 'goal?': 'string' },
      plan: () => ({ summary: 'nothing', effects: [], apply: () => null }),
    });
}

async function toolsOf(k: Keys, services: Service[], o = {}) {
  const clients = await Promise.all(
    services.map(async (s, i) => ({
      client: await agentClient(k, recorded(s).t, [EACH_40]),
      url: `test:${i}`,
    })),
  );
  const factory = await bridge(clients, o);
  const conn = await connect('2026', factory);
  const { tools } = await conn.client.listTools();

  return {
    tools,
    conn,
    factory,
    byName: new Map(tools.map((t) => [t.name, t])),
  };
}

describe('tool names', () => {
  it('are the capability names made safe, with a suffix on collision or the yea_ prefix', async () => {
    const k = await keys();
    const { byName } = await toolsOf(k, [lab(k)]);
    const long = `long.${'x'.repeat(80)}`;

    expect([...byName.keys()].sort()).toEqual(
      [
        `a_b_${await suffix('lab.example', 'a.b')}`,
        `a_b_${await suffix('lab.example', 'a_b')}`,
        'lab_schema',
        sanitize(long),
        `yea_undo_${await suffix('lab.example', 'yea_undo')}`,
        'yea_consent',
        'yea_expand',
        'yea_undo',
      ].sort(),
    );
    expect(sanitize(long)).toHaveLength(57);

    for (const name of byName.keys()) {
      expect(name).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    }

    // The real names ride along in _meta.
    expect(
      byName.get(`a_b_${await suffix('lab.example', 'a.b')}`)?._meta,
    ).toEqual({
      'dev.yea/service': 'lab.example',
      'dev.yea/capability': 'a.b',
    });
    // The utility keeps its own name and schema.
    expect(byName.get('yea_undo')?.inputSchema.required).toEqual([
      'service',
      'receipt',
    ]);
  });

  it('two services sharing a capability both get a suffix', async () => {
    const k = await keys();
    const trust = [k.principal.public];
    const { byName } = await toolsOf(k, [
      shop({ trust, id: 'shop.a' }),
      shop({ trust, id: 'shop.b' }),
    ]);

    expect(byName.has('shop_order')).toBe(false);
    expect(
      byName.has(`shop_order_${await suffix('shop.a', 'shop.order')}`),
    ).toBe(true);
    expect(
      byName.has(`shop_order_${await suffix('shop.b', 'shop.order')}`),
    ).toBe(true);
  });

  it('refuses to build a job tool whose param would shadow goal, preview or proposal', async () => {
    const k = await keys();
    const { byName } = await toolsOf(k, [lab(k)]);

    expect(byName.has('lab_goal')).toBe(false);
  });
});

describe('schemas and annotations', () => {
  it('map the compact schema to JSON Schema', async () => {
    const k = await keys();
    const { byName } = await toolsOf(k, [lab(k)]);

    expect(byName.get('lab_schema')?.inputSchema).toEqual({
      type: 'object',
      properties: {
        s: { type: 'string' },
        i: { type: 'integer' },
        n: { type: 'number' },
        b: { type: 'boolean' },
        d: { type: 'string', format: 'date' },
        dt: {
          type: 'string',
          format: 'date-time',
          description: 'when it starts',
        },
        x: {},
        e: { type: 'string', enum: ['low', 'high'] },
        tags: {
          type: 'array',
          items: { type: 'string', enum: ['red', 'green'] },
        },
        names: { type: 'array', items: { type: 'string' } },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              sku: { type: 'string' },
              qty: { type: 'integer', description: 'how many' },
            },
            required: ['sku'],
          },
        },
        nested: {
          type: 'object',
          properties: {
            deep: {
              type: 'object',
              properties: { at: { type: 'string', format: 'date-time' } },
              required: ['at'],
            },
          },
          required: ['deep'],
        },
        odd: {},
      },
      required: ['s', 'i', 'n', 'b', 'd', 'dt', 'x', 'e', 'items', 'nested'],
    });
  });

  it('read tools are read-only; job tools are destructive and take goal, preview and proposal', async () => {
    const k = await keys();
    const trust = [k.principal.public];
    const { byName } = await toolsOf(k, [calendar({ trust }), shop({ trust })]);
    const read = byName.get('shop_search');
    const job = byName.get('shop_order');

    expect(read?.annotations).toMatchObject({ readOnlyHint: true });
    expect(job?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });
    expect(Object.keys(job?.inputSchema.properties ?? {})).toEqual([
      'items',
      'deliver',
      'goal',
      'preview',
      'proposal',
    ]);
    expect(read?.description).toBe(
      'Search the menu (shop.search at shop.example)',
    );
  });

  it('passes arguments through unchanged: the service validates and teaches', async () => {
    const k = await keys();
    const trust = [k.principal.public];
    const { conn } = await toolsOf(k, [shop({ trust })]);
    const r = await conn.call({ max_cal: 'lots' }, 'shop_search');

    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(
      /^✗ invalid_params: `max_cal` must be an integer/,
    );
  });
});

describe('start-up', () => {
  it('EXPANDs elided capabilities, so every one gets a tool', async () => {
    const k = await keys();
    const trust = [k.principal.public];
    const rec = recorded(calendar({ trust }));
    // A service that answers HELLO tightly, eliding its capability list.
    const tight = {
      request: (
        f: Parameters<typeof rec.t.request>[0],
        e?: Parameters<typeof rec.t.request>[1],
      ) => rec.t.request(f.verb === 'HELLO' ? { ...f, budget: 60 } : f, e),
      close() {},
    };
    const factory = await bridge([await agentClient(k, tight)]);

    expect(rec.verbs('EXPAND').length).toBeGreaterThan(0);
    expect(factory.tools.sort()).toEqual([
      'calendar_agenda',
      'calendar_book',
      'calendar_cancel',
      'calendar_free',
      'calendar_reschedule',
    ]);
  });

  it('refuses to start when two services claim the same id, naming both', async () => {
    const k = await keys();
    const trust = [k.principal.public];

    await expect(
      bridge([
        {
          client: await agentClient(k, recorded(shop({ trust })).t),
          url: 'yea://one',
        },
        {
          client: await agentClient(k, recorded(shop({ trust })).t),
          url: 'yea://two',
        },
      ]),
    ).rejects.toThrow(
      /yea:\/\/one and yea:\/\/two both claim the service id "shop.example"/,
    );
  });

  it('reports a service it can reach, and one it cannot, in the instructions', async () => {
    const k = await keys();
    const trust = [k.principal.public];
    const down = {
      request: () => Promise.reject(new Error('connection refused')),
      close() {},
    };
    const factory = await bridge([
      {
        client: await agentClient(k, recorded(shop({ trust })).t),
        url: 'yea://shop',
      },
      { client: await agentClient(k, down), url: 'yea://down' },
    ]);

    expect(factory.instructions).toContain('# Example Meals (shop.example)');
    expect(factory.instructions).toContain(
      'yea://down could not be reached: connection refused',
    );
  });
});

/** A service with `n` read and one job capability. */
function big(k: Keys, n: number) {
  let s = service({
    id: 'big.example',
    name: 'Big',
    summary: 'Many',
    trust: [k.principal.public],
  });

  for (let i = 0; i < n; i++) {
    s = s.ask(`big.r${i}`, {
      summary: `read ${i}`,
      params: { 'q?': 'string' },
      run: ({ params }) => ({ i, q: params.q ?? null }),
    });
  }

  return s.intent('big.w', {
    summary: 'write',
    params: { v: 'int' },
    plan: ({ params }) => ({
      summary: `write ${params.v}`,
      effects: [{ op: 'create', target: 'thing' }],
      undoWindow: 60,
      apply: () => ({ wrote: params.v }),
      revert: () => null,
    }),
  });
}

describe('the generic fallback', () => {
  it('a service past 25 capabilities gets two generic tools; the others keep theirs', async () => {
    const k = await keys();
    const trust = [k.principal.public];
    const { byName, factory, conn } = await toolsOf(k, [
      big(k, 25),
      shop({ trust }),
    ]);

    expect([...byName.keys()].filter((n) => n.startsWith('big'))).toEqual([
      'big_example_ask',
      'big_example_intent',
    ]);
    expect(byName.has('shop_order')).toBe(true);
    expect(factory.instructions).toContain(
      'Use big_example_ask and big_example_intent',
    );
    expect(factory.instructions).toContain('ask big.r0');

    const read = await conn.call(
      { capability: 'big.r3', params: { q: 'hi' } },
      'big_example_ask',
    );

    expect(textOf(read)).toBe('i: 3\nq: hi');

    // A generic intent call runs the same steps: here, an auto-commit within the grant.
    const done = await conn.call(
      { capability: 'big.w', params: { v: 7 } },
      'big_example_intent',
    );

    expect(textOf(done)).toMatch(/^✓ write 7/);

    const wrong = await conn.call(
      { capability: 'big.r3' },
      'big_example_intent',
    );

    expect(textOf(wrong)).toMatch(
      /not one of big.example's intent capabilities/,
    );
  });

  it('25 capabilities or fewer keep per-capability tools', async () => {
    const k = await keys();
    const { byName } = await toolsOf(k, [big(k, 24)]);

    expect(byName.has('big_r0')).toBe(true);
    expect(byName.has('big_w')).toBe(true);
  });

  it('--tools forces one mode for every service', async () => {
    const k = await keys();
    const trust = [k.principal.public];
    const generic = await toolsOf(k, [shop({ trust })], { tools: 'generic' });

    expect(
      [...generic.byName.keys()].filter((n) => !n.startsWith('yea_')),
    ).toEqual(['shop_example_ask', 'shop_example_intent']);

    const each = await toolsOf(k, [big(k, 30)], { tools: 'per-capability' });

    expect(each.byName.has('big_r29')).toBe(true);
  });

  it('a generic tool name keeps its suffix rules: a yea. service id gets one', async () => {
    const k = await keys();
    const svc = service({
      id: 'yea.svc',
      name: 'Y',
      summary: 's',
      trust: [k.principal.public],
    }).ask('x', { summary: 'x', run: () => 1 });
    const { byName } = await toolsOf(k, [svc], { tools: 'generic' });

    expect(byName.has(`yea_svc_ask_${await suffix('yea.svc', 'ask')}`)).toBe(
      true,
    );
  });
});

describe('the pending key', () => {
  it('hashes params as sorted JSON, floats included', () => {
    expect(
      sortedJson({ b: 1.5, a: { d: [2.25, { z: 1, y: 0.1 }], c: null } }),
    ).toBe('{"a":{"c":null,"d":[2.25,{"y":0.1,"z":1}]},"b":1.5}');
  });
});
