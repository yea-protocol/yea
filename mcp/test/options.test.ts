/**
 * Closed options (SPEC-mcp-ts, "Closed options"; SPEC-bridge, "Package and compatibility"): an
 * unknown key, a missing required one, or a value not of its documented type throws before
 * anything is registered, served or written, and the error names the key and the known ones.
 * The refusals that close a security hole are in security.test.ts and bridge-security.test.ts.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import { type BridgeOptions, bridge } from '../src/bridge.js';
import { httpApp, httpGate } from '../src/http.js';
import { serveHttp } from '../src/http-node.js';
import {
  type GuardConfig,
  type JobConfig,
  type YeaOptions,
  yea,
} from '../src/index.js';
import { examples, keys } from './bridge-helpers.js';
import { connect, refundJob, tmp, world } from './helpers.js';

type Refund = JobConfig<z.ZodObject<{ charge: z.ZodString }>>;

const TOKEN = 't'.repeat(40);

/** What `fn` threw: a TypeError, by contract. */
function thrown(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(TypeError);

    return (e as Error).message;
  }

  throw new Error('expected a throw');
}

/** The keys a refusal names as known, without a nested path's prefix, sorted. */
const knownIn = (message: string) =>
  (/; known: (.*)$/.exec(message)?.[1] ?? '')
    .split(', ')
    .map((k) => k.replace(/^.*\./, ''))
    .sort();

/** `yea()` over a temp home, with `over` laid on top unchecked, as JavaScript would pass it. */
function start(over: Record<string, unknown>) {
  const home = tmp();
  const options = { name: 'billing', transport: 'stdio', home, ...over };

  return { home, run: () => yea(options as unknown as YeaOptions) };
}

/** A server with one plain tool, `charge`, and the approvals to register on it. */
async function onServer() {
  const w = await world();
  const server = new McpServer(
    { name: 'billing', version: '1' },
    w.approvals.serverOptions(),
  );
  const tool = server.registerTool(
    'charge',
    { inputSchema: z.object({ amount: z.string() }) },
    () => ({ content: [] }),
  );

  return { w, server, tool };
}

/** Each tool `server` lists, by name. */
async function listed(server: McpServer) {
  const conn = await connect('2026', () => server);
  const { tools } = await conn.client.listTools();

  return Object.fromEntries(tools.map((t) => [t.name, t]));
}

describe('yea() refuses options it does not take', () => {
  it('an unknown key, even one set to undefined, naming it and the known ones', () => {
    const typo = thrown(start({ requireInteractio: true }).run);

    expect(typo).toMatch(
      /^yea\(\): unknown option "requireInteractio"; known: name, transport, /,
    );
    expect(typo).toMatch(/, requireInteraction$/);
    expect(thrown(start({ loopback: undefined }).run)).toMatch(
      /unknown option "loopback"/,
    );
  });

  it('a value not of its type', () => {
    expect(thrown(start({ singleProcess: 'true' }).run)).toBe(
      'yea(): singleProcess must be true or false',
    );
    expect(thrown(start({ requireInteraction: 'false' }).run)).toBe(
      'yea(): requireInteraction must be true or false',
    );
    expect(thrown(start({ home: 1 }).run)).toBe('yea(): home must be a string');
    expect(thrown(start({ sub: 'me' }).run)).toBe(
      'yea(): sub must be a function',
    );
    expect(thrown(start({ store: {} }).run)).toBe(
      'yea(): store must be an ApprovalStore',
    );
    expect(thrown(start({ codec: { verify: 1 } }).run)).toBe(
      'yea(): codec must be a createRequestStateCodec result',
    );
    expect(thrown(start({ stateKey: 32 }).run)).toBe(
      'yea(): stateKey must be a string or a Uint8Array',
    );
  });

  it('a missing required key, an unlisted transport, and options that are not an object', () => {
    expect(thrown(start({ name: undefined }).run)).toBe(
      'yea(): name is required: a string',
    );
    expect(thrown(start({ transport: 'sse' }).run)).toBe(
      "yea(): transport must be 'stdio' or 'http'",
    );

    for (const o of [undefined, null, 'billing', ['billing']]) {
      expect(thrown(() => yea(o as unknown as YeaOptions))).toBe(
        'yea(): the options must be an object',
      );
    }
  });

  it('writes nothing when it refuses: no server key is created', () => {
    const s = start({ requireInteractio: true });

    thrown(s.run);
    expect(existsSync(join(s.home, 'server'))).toBe(false);
  });

  it('names a nested key by its path', () => {
    expect(thrown(start({ tighten: { dney: ['refund'] } }).run)).toBe(
      'yea(): unknown option "tighten.dney"; known: tighten.deny, tighten.outOfBand',
    );
  });

  it('takes every documented key, and undefined for an optional one', () => {
    expect(
      start({
        principal: undefined,
        policy: undefined,
        tighten: { deny: ['refund'], outOfBand: 'medium' },
        requireInteraction: false,
      }).run,
    ).not.toThrow();
  });
});

describe('job() refuses a config it does not take, and registers nothing', () => {
  it('an unknown key, outputSchema, a missing plan, a value not of its type', async () => {
    const { w, server } = await onServer();
    const job = (over: Record<string, unknown>) => () =>
      w.approvals.job(server, 'refund', { ...refundJob(w), ...over } as Refund);

    expect(thrown(job({ requireInteractoin: true }))).toMatch(
      /^job\(\): unknown option "requireInteractoin"; known: /,
    );
    expect(thrown(job({ outputSchema: z.object({}) }))).toBe(
      "job(): outputSchema isn't accepted: a job's results are YEA's (plans, receipts and refusals), not the tool's",
    );
    expect(thrown(job({ plan: undefined }))).toBe(
      'job(): plan is required: a function',
    );
    expect(thrown(job({ inputSchema: undefined }))).toBe(
      'job(): inputSchema is required: a Standard Schema',
    );
    expect(thrown(job({ risk: 'hgh' }))).toBe(
      "job(): risk must be 'low', 'medium' or 'high'",
    );
    expect(thrown(job({ requireInteraction: 'yes' }))).toBe(
      'job(): requireInteraction must be true or false',
    );
    expect(thrown(job({ annotations: { readOnlyHnt: true } }))).toMatch(
      /^job\(\): unknown option "annotations.readOnlyHnt"; known: annotations.title, /,
    );
    expect(thrown(job({ annotations: { destructiveHint: 'no' } }))).toBe(
      'job(): annotations.destructiveHint must be true or false',
    );
    expect(thrown(job({ icons: [{ source: 'x' }] }))).toBe(
      'job(): icons must be an array of icons, each with a string src',
    );
    expect(thrown(job({ _meta: 'x' }))).toBe('job(): _meta must be an object');
    // Nothing was registered, not even undo.
    expect(Object.keys(await listed(server))).toEqual(['charge']);
  });

  it("passes _meta and icons on, and YEA's own _meta keys win", async () => {
    const { w, server } = await onServer();
    const icons = [{ src: 'https://example.com/refund.png' }];

    w.approvals.job(server, 'refund', {
      ...refundJob(w),
      icons,
      _meta: { 'example.com/own': 1, 'dev.yea/job': 'mine' },
    });

    const { refund } = await listed(server);

    expect(refund._meta).toEqual({
      'example.com/own': 1,
      'dev.yea/job': { risk: 'low', undoable: true },
    });
    expect(refund.icons).toEqual(icons);
  });
});

describe('guard() refuses a config it does not take', () => {
  it('an unknown key, a missing describe, an unknown risk; the tool is left as it was', async () => {
    const { w, server, tool } = await onServer();
    const guard = (over: Record<string, unknown>) => () =>
      w.approvals.guard(server, tool, {
        describe: () => ({ summary: 'Charge', effects: [] }),
        ...over,
      } as GuardConfig);

    expect(thrown(guard({ requireInteractio: true }))).toBe(
      'guard(): unknown option "requireInteractio"; known: describe, risk, requireInteraction, revert, confirmWith',
    );
    expect(thrown(guard({ describe: undefined }))).toBe(
      'guard(): describe is required: a function',
    );
    expect(thrown(guard({ risk: 'hgh' }))).toBe(
      "guard(): risk must be 'low', 'medium' or 'high'",
    );
    expect(tool.enabled).toBe(true);
    expect((await listed(server)).charge._meta).toBeUndefined();
  });
});

describe('bridge() refuses options it does not take, before greeting a service', () => {
  /** The refusal's message; the services got no request. */
  async function refusal(o: Record<string, unknown>) {
    const k = await keys();
    const ex = await examples(k);
    const error = await bridge(ex.clients, {
      home: k.home,
      ...o,
    } as BridgeOptions).then(
      () => new Error('expected a refusal'),
      (e: Error) => e,
    );

    expect(error).toBeInstanceOf(TypeError);
    expect([...ex.cal.sent, ...ex.shop.sent]).toEqual([]);

    return error.message;
  }

  it('an unknown key, an unlisted tool mode, a budget of 0', async () => {
    expect(await refusal({ requireInteractio: true })).toBe(
      'bridge(): unknown option "requireInteractio"; known: tools, budget, home, consents, tighten, requireInteraction, now',
    );
    expect(await refusal({ tools: 'generc' })).toBe(
      "bridge(): tools must be 'auto', 'generic' or 'per-capability'",
    );
    expect(await refusal({ budget: 0 })).toBe(
      'bridge(): budget must be a whole number ≥ 1',
    );
    expect(await refusal({ tighten: { dney: [] } })).toBe(
      'bridge(): unknown option "tighten.dney"; known: tighten.deny',
    );
  });
});

describe('the HTTP front end refuses options it does not take', () => {
  const app = { token: TOKEN, sub: 'person-1', loopback: true };
  const factory = () => new McpServer({ name: 'x', version: '1' });
  const http = (o: Record<string, unknown>) => () =>
    httpApp(factory, o as unknown as Parameters<typeof httpApp>[1]);
  const gate = (o: Record<string, unknown>) => () =>
    httpGate(o as unknown as Parameters<typeof httpGate>[0]);

  it('httpApp and httpGate: an unknown key, a missing required one', () => {
    for (const check of [http, gate]) {
      expect(thrown(check({ ...app, clientID: 'c' }))).toMatch(
        /unknown option "clientID"; known: token, sub, loopback, clientId, maxBody$/,
      );
      expect(thrown(check({ ...app, token: undefined }))).toMatch(
        /token is required: a string$/,
      );
    }

    expect(thrown(http({ ...app, sub: undefined }))).toBe(
      'httpApp(): sub is required: a string',
    );
    expect(thrown(http({ ...app, maxBody: -1 }))).toBe(
      'httpApp(): maxBody must be a whole number ≥ 0',
    );
  });

  it("httpGate takes httpApp's options, so one object serves both", () => {
    expect(gate({ ...app, clientId: 'c', maxBody: 10 })).not.toThrow();
    expect(gate({ token: TOKEN, loopback: false })).not.toThrow();
  });

  it('serveHttp: an unknown key or a bad value, before it listens', () => {
    const serve = (o: Record<string, unknown>) => () =>
      serveHttp(
        async () => new Response(),
        o as unknown as Parameters<typeof serveHttp>[1],
      );
    const at = { port: 0, host: '127.0.0.1' };

    expect(thrown(serve({ ...at, headers: false }))).toBe(
      'serveHttp(): unknown option "headers"; known: port, host, maxBody, gate, requestTimeout, maxConnections',
    );
    expect(thrown(serve({ ...at, port: '8080' }))).toBe(
      'serveHttp(): port must be a port number, 0 to 65535',
    );
    expect(thrown(serve({ ...at, gate: app }))).toBe(
      'serveHttp(): gate must be a function',
    );
    expect(thrown(serve({ ...at, requestTimeout: 0 }))).toBe(
      'serveHttp(): requestTimeout must be a whole number ≥ 1',
    );
  });
});

describe("the known keys are the spec's", () => {
  const spec = (name: string) =>
    readFileSync(
      new URL(`../../docs/framework/${name}`, import.meta.url),
      'utf8',
    );

  /** The keys the row for `fn` in SPEC-mcp-ts's closed-options table lists, sorted. */
  function row(fn: string): string[] {
    const line = spec('SPEC-mcp-ts.md')
      .split('\n')
      .find((l) => l.startsWith(`| \`${fn}\` |`));

    expect(line, fn).toBeDefined();

    return [...(line ?? '').split('|')[2].matchAll(/`([^`]+)`/g)]
      .map((m) => m[1])
      .sort();
  }

  it('SPEC-mcp-ts: each function, and each nested object', async () => {
    const { w, server, tool } = await onServer();
    const refund = (over: Record<string, unknown>) => () =>
      w.approvals.job(server, 'refund', { ...refundJob(w), ...over } as Refund);
    const cases: [string, () => unknown][] = [
      ['yea(options)', start({ x: 1 }).run],
      ['yea({ tighten })', start({ tighten: { x: 1 } }).run],
      ['approvals.job(server, name, config)', refund({ x: 1 })],
      ['job({ annotations })', refund({ annotations: { x: 1 } })],
      [
        'approvals.guard(server, tool, config)',
        () => w.approvals.guard(server, tool, { x: 1 } as never),
      ],
      [
        'httpApp(factory, options)',
        () => httpApp(() => server, { x: 1 } as never),
      ],
      ['httpGate(options)', () => httpGate({ x: 1 } as never)],
      [
        'serveHttp(app, options)',
        () => serveHttp(async () => new Response(), { x: 1 } as never),
      ],
    ];

    for (const [fn, refused] of cases) {
      expect(knownIn(thrown(refused)), fn).toEqual(row(fn));
    }
  });

  it("SPEC-bridge: the sentence that lists bridge()'s options", async () => {
    // The list only: backticked names joined by commas and a last "and", the lines wrapped.
    const sentence =
      /Its options are ((?:`[^`]+`(?:,\s+|\s+and\s+))+`[^`]+`)/.exec(
        spec('SPEC-bridge.md'),
      );
    const named = [...(sentence?.[1] ?? '').matchAll(/`([^`]+)`/g)];
    const message = await bridge([], { home: tmp(), x: 1 } as never).then(
      () => '',
      (e: Error) => e.message,
    );

    expect(knownIn(message)).toEqual(named.map((m) => m[1]).sort());
  });
});
