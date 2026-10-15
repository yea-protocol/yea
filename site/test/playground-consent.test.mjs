/**
 * Tests for the playground's consent check (consent-check.ts, #276): it checks the service's
 * consent request against the proposal the agent committed, signs only a consent built from
 * that proposal, and says why when it refuses. They import the TypeScript source and the built
 * SDK, so they need Node's type stripping (22.18+) and `npm run build` first.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';

const THEME = '../.vitepress/theme/components/playground';
const built = existsSync(new URL('../../ts/dist/index.js', import.meta.url));
const skip =
  (!process.features.typescript &&
    'needs Node with type stripping (22.18+) to import .ts') ||
  (!built && 'needs npm run build');

/** A proposal the agent received from the shop, its consent request, and the exchange. */
async function setup() {
  const sdk = await import('../../ts/dist/index.js');
  const check = await import(`${THEME}/consent-check.ts`);
  const bound = {
    id: 'p_1',
    capability: 'shop.order',
    summary: '4 meals — 53.95 USD',
    effects: [{ op: 'create', target: 'order/1' }],
    risk: 'low',
    undo: null,
    expires: 4_000_000_000,
  };
  const p = { ...bound, hash: await sdk.proposalHash(bound) };
  const received = { ...p, service: 'shop' };
  const seen = {
    proposals: [{ ...received, id: 'p_0' }, received],
    receipts: [],
    handles: [],
  };
  const k = {
    proposal: p.id,
    hash: p.hash,
    service: 'shop.example',
    capability: p.capability,
    principal: 'pk',
    summary: p.summary,
    expires: p.expires,
  };
  const exchange = {
    service: 'shop',
    request: { verb: 'COMMIT', proposal: p.id, hash: p.hash },
  };

  return { sdk, check, p, received, seen, k, exchange };
}

test('committedProposal: the proposal the COMMIT named, at its service', {
  skip,
}, async () => {
  const { check, received, seen, exchange } = await setup();

  assert.equal(check.committedProposal(seen, exchange), received);
  assert.equal(
    check.committedProposal(seen, { ...exchange, service: 'calendar' }),
    null,
  );
  assert.equal(
    check.committedProposal(seen, {
      ...exchange,
      request: { ...exchange.request, hash: 'x' },
    }),
    null,
  );
  assert.equal(
    check.committedProposal(seen, { ...exchange, request: { verb: 'UNDO' } }),
    null,
  );
});

test("checkAgainst: signs a consent built from the proposal, not the service's request", {
  skip,
}, async () => {
  const { sdk, check, p, received, k } = await setup();
  const lying = { ...k, summary: 'something else', expires: p.expires + 999 };
  const r = await check.checkAgainst(sdk, lying, received, 'shop');

  assert.equal(r.state, 'ok');
  assert.deepEqual(r.consent, { ...k, summary: p.summary });
});

test('checkAgainst: refuses a request that names another proposal, hash, capability or service, or a tampered proposal, and says why', {
  skip,
}, async () => {
  const { sdk, check, received, k } = await setup();
  const refusals = [
    [{ ...k, proposal: 'p_x' }, received, 'shop', 'names another proposal'],
    [{ ...k, hash: 'x' }, received, 'shop', "hash isn't the proposal's"],
    [{ ...k, capability: 'shop.x' }, received, 'shop', 'another capability'],
    [k, received, 'calendar', 'names another service'],
    [k, { ...received, summary: '1 roll' }, 'shop', "doesn't match its hash"],
  ];

  for (const [request, proposal, service, why] of refusals) {
    const r = await check.checkAgainst(sdk, request, proposal, service);

    assert.equal(r.state, 'refused', why);
    assert.match(r.why, new RegExp(why));
  }
});
