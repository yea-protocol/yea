/**
 * The `home` option (SPEC-mcp-ts `yea()`, SPEC-bridge): `policy.json`, the default store, the
 * server key and the bridge's consents live in it, and the entry point resolves it once.
 */
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { saveGrant } from '@yea-protocol/sdk/node';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bridge } from '../src/bridge.js';
import { yea } from '../src/index.js';
import {
  approveCode,
  BIG_ORDER,
  bridged,
  examples,
  keys,
  proposalsOf,
  writePolicy,
} from './bridge-helpers.js';
import {
  connect,
  grantPolicy,
  refundServer,
  textOf,
  tmp,
  type World,
  world,
} from './helpers.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

const ch1 = { charge: 'ch_1' };

const deny = (w: World, names: string[]) =>
  writeFileSync(join(w.home, 'policy.json'), JSON.stringify({ deny: names }));

/** Refund ch_1 and return the receipt id. */
async function refundedIn(w: World) {
  const r = await (await connect('2026', refundServer(w))).call(ch1);

  expect(r.isError).toBeFalsy();

  return (r.structuredContent as { receipt: { id: string } }).receipt.id;
}

describe('two job servers in one process, each with its own home', () => {
  it('read their own policy.json deny list and keep their own default store', async () => {
    // No store option and no YEA_STORE: each server's store is the `store` directory in its home.
    vi.stubEnv('YEA_STORE', '');

    const a = await world({ store: undefined });
    const b = await world({ store: undefined });

    await grantPolicy(a);
    await grantPolicy(b);
    deny(a, ['refund']);
    deny(b, ['something_else']);

    const refused = await (await connect('2026', refundServer(a))).call(ch1);

    expect(textOf(refused)).toMatch(/your policy never allows refund/);
    expect(a.applied).toEqual([]);

    const inB = await refundedIn(b);

    // policy.json is read on every call, so lifting a's deny applies at once.
    deny(a, []);

    const inA = await refundedIn(a);

    expect(await a.store.getReceipt(inA)).not.toBeNull();
    expect(await b.store.getReceipt(inB)).not.toBeNull();
    expect(await a.store.getReceipt(inB)).toBeNull();
    expect(await b.store.getReceipt(inA)).toBeNull();
    expect(existsSync(join(a.home, 'server', 'billing.key'))).toBe(true);
    expect(existsSync(join(b.home, 'server', 'billing.key'))).toBe(true);
  });

  it('never read principal.key from the home: no pinned key means nothing auto-runs', async () => {
    vi.stubEnv('YEA_PRINCIPAL_PUB', '');

    const w = await world({ principal: undefined });

    writeFileSync(join(w.home, 'principal.key'), `${w.principal.seed}\n`);
    await grantPolicy(w);

    const r = await (await connect('2025-no-elicit', refundServer(w))).call(
      ch1,
    );

    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/No consent can be accepted/);
    expect(w.applied).toEqual([]);
  });
});

describe('two bridges in one process, each with its own home', () => {
  it('read their own policy.json deny list and keep their own consents', async () => {
    const a = await keys();
    const b = await keys();

    writePolicy(a, { deny: ['shop.order'] });

    const inA = await bridged(a);
    const inB = await bridged(b);

    expect(textOf(await inA.conn.call(BIG_ORDER, 'shop_order'))).toMatch(
      /your policy never allows shop\.order/,
    );

    const { proposals, codes } = proposalsOf(
      await inB.conn.call(BIG_ORDER, 'shop_order'),
    );

    // `yea approve` on b's machine saves the consent in b's home; b's bridge finds it there.
    saveGrant(
      await approveCode(b.principal, codes[0].code),
      'consents',
      proposals[0].hash,
      b.home,
    );

    expect(textOf(await inB.conn.call(BIG_ORDER, 'shop_order'))).toContain(
      '✓ 4 meals',
    );
    expect(readdirSync(join(b.home, 'consents'))).toHaveLength(1);
    expect(existsSync(join(a.home, 'consents'))).toBe(false);
  });
});

/** The entry points' own default: `YEA_HOME`, read once when the server is made. */
describe('without a home option', () => {
  it('yea() takes YEA_HOME at start-up, and a later change is not seen', async () => {
    const w = await world();

    vi.stubEnv('YEA_HOME', w.home);

    const approvals = yea({ ...w.options, name: 'other', home: undefined });

    vi.stubEnv('YEA_HOME', tmp());
    deny(w, ['refund']);

    const conn = await connect('2026', refundServer(w, {}, { approvals }));

    expect(textOf(await conn.call(ch1))).toMatch(
      /your policy never allows refund/,
    );
    expect(existsSync(join(w.home, 'server', 'other.key'))).toBe(true);
  });

  it('bridge() takes YEA_HOME at start-up, and a later change is not seen', async () => {
    const k = await keys();
    const ex = await examples(k);

    vi.stubEnv('YEA_HOME', k.home);

    const factory = await bridge(ex.clients);

    vi.stubEnv('YEA_HOME', tmp());
    writePolicy(k, { deny: ['shop.order'] });

    const conn = await connect('2026', factory);

    expect(textOf(await conn.call(BIG_ORDER, 'shop_order'))).toMatch(
      /your policy never allows shop\.order/,
    );
  });
});
