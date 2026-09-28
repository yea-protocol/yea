import {
  chmodSync,
  existsSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { MemoryStore } from '@yea-protocol/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { type YeaOptions, yea } from '../src/index.js';
import {
  connect,
  grantPolicy,
  refundServer,
  textOf,
  tmp,
  world,
} from './helpers.js';

afterEach(() => {
  delete process.env.YEA_HOME;
});

/** yea() with a temp home and key, so only the option under test can refuse. */
function start(over: Partial<YeaOptions>) {
  process.env.YEA_HOME = tmp();

  return () =>
    yea({
      name: 'billing',
      transport: 'stdio',
      principal: undefined,
      ...over,
    } as YeaOptions);
}

describe('start-up refusals: yea() throws, so nothing is served', () => {
  it('HTTP without a sub function', () => {
    expect(start({ transport: 'http', singleProcess: true })).toThrow(
      /HTTP needs sub/,
    );
  });

  it('a stateKey with a MemoryStore', () => {
    expect(
      start({ store: new MemoryStore(), stateKey: 'k'.repeat(32) }),
    ).toThrow(/shared stateKey needs a shared store/);
    expect(
      start({
        transport: 'http',
        sub: () => 'a',
        singleProcess: true,
        stateKey: 'k'.repeat(32),
      }),
    ).toThrow(/shared stateKey needs a shared store/);
  });

  it('HTTP on a MemoryStore without singleProcess', () => {
    expect(start({ transport: 'http', sub: () => 'a' })).toThrow(
      /singleProcess: true/,
    );
    expect(
      start({ transport: 'http', sub: () => 'a', singleProcess: true }),
    ).not.toThrow();
  });

  it('an invalid name', () => {
    for (const name of ['', 'Billing', 'a/b', '../x', 'x'.repeat(65)]) {
      expect(start({ name })).toThrow(/name must match/);
    }
  });

  it('an unsafe key file: a symlink, or readable by others', () => {
    const dir = tmp();
    const real = join(dir, 'real.key');
    const link = join(dir, 'link.key');

    writeFileSync(real, `${'A'.repeat(43)}\n`, { mode: 0o600 });
    symlinkSync(real, link);
    expect(start({ serverKey: link })).toThrow(/is a symlink/);

    chmodSync(real, 0o644);
    expect(start({ serverKey: real })).toThrow(/can be read by other users/);

    chmodSync(real, 0o600);
    writeFileSync(real, 'not a seed\n');
    expect(start({ serverKey: real })).toThrow(/does not hold an Ed25519 seed/);
  });

  it('a key directory others can write is refused', () => {
    const dir = tmp();

    chmodSync(dir, 0o770);
    expect(start({ serverKey: join(dir, 'k.key') })).toThrow(
      /can be written by other users/,
    );
  });

  it('a dangling symlink is refused, not replaced', () => {
    const dir = tmp();
    const link = join(dir, 'k.key');

    symlinkSync(join(dir, 'nowhere'), link);
    expect(start({ serverKey: link })).toThrow(/is a symlink/);
    expect(existsSync(join(dir, 'nowhere'))).toBe(false);
  });

  it('creates the key file on first run: 0600 in a 0700 directory, then reuses it', async () => {
    const home = tmp();

    process.env.YEA_HOME = home;

    const a = yea({ name: 'billing', transport: 'stdio' });
    const key = join(home, 'server', 'billing.key');

    expect(existsSync(key)).toBe(true);
    // Written to a temp file and linked into place; the temp file is gone.
    expect(readdirSync(join(home, 'server'))).toEqual(['billing.key']);
    expect(statSync(key).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, 'server')).mode & 0o777).toBe(0o700);
    expect(await yea({ name: 'billing', transport: 'stdio' }).serviceId()).toBe(
      await a.serviceId(),
    );
  });

  it('a codec and a stateKey together', () => {
    const codec = yea({
      name: 'x',
      transport: 'stdio',
      serverKey: join(tmp(), 'k'),
    });

    expect(
      start({
        stateKey: 'k'.repeat(32),
        codec: {
          mint: async () => '',
          verify: codec.serverOptions().requestState.verify,
        },
      }),
    ).toThrow(/either codec or stateKey/);
  });
});

describe('per-call refusals', () => {
  it('HTTP: a sub that returns no identity refuses the call', async () => {
    const w = await world({
      transport: 'http',
      store: new MemoryStore(),
      singleProcess: true,
      sub: () => '',
    });
    const conn = await connect('2026', refundServer(w));
    const r = await conn.call({ charge: 'ch_1' });

    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/no authenticated caller/);
    expect(w.applied).toEqual([]);
  });

  it('stdio is one process: a MemoryStore keeps a total for it, and the policy is re-read', async () => {
    const w = await world({ store: new MemoryStore() });

    await grantPolicy(w, [
      { can: ['refund'] },
      { risk: 'low' },
      { total: { of: 'emails', max: 1 } },
    ]);

    const conn = await connect('2025-no-elicit', refundServer(w));

    expect((await conn.call({ charge: 'ch_1' })).isError).toBeFalsy();
    expect((await conn.call({ charge: 'ch_2' })).isError).toBe(true);
    expect(w.applied).toEqual(['ch_1']);

    // The policy is read on every call: one without a total runs.
    await grantPolicy(w, [{ can: ['refund'] }]);
    expect((await conn.call({ charge: 'ch_2' })).isError).toBeFalsy();
  });
});

describe('job() refuses schemas it can’t carry preview on', () => {
  it('a root that is not a plain object, or has a preview field', async () => {
    const z = await import('zod');
    const { McpServer } = await import('@modelcontextprotocol/server');
    const w = await world();
    const server = new McpServer(
      { name: 'b', version: '1' },
      w.approvals.serverOptions(),
    );
    const job = (inputSchema: unknown) => () =>
      w.approvals.job(server, 'x', {
        inputSchema: inputSchema as never,
        plan: () => [],
      });

    expect(job(z.object({ preview: z.boolean() }))).toThrow(
      /field named preview/,
    );
    expect(job(z.string())).toThrow(/plain object at its root/);
    expect(
      job({
        '~standard': {
          version: 1,
          vendor: 'x',
          validate: () => ({ value: {} }),
        },
      }),
    ).toThrow(/exposes JSON Schema/);
  });
});
