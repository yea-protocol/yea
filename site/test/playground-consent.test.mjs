/**
 * Tests for the playground's consent round (consent-check.ts, #276, #277): a COMMIT goes through
 * the SDK's consent round, which checks the service's consent request against the proposal the
 * agent received, waits on the human, and signs only a consent built from that proposal. They
 * import the TypeScript source and the built SDK, so they need Node's type stripping (22.18+)
 * and `npm run build` first.
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

/**
 * A shop client whose COMMIT replies pass through `edit`, as a lying service's would, counting
 * its COMMITs; a proposal over its 10 USD limit, as the playground received it; the keys.
 */
async function setup(edit = (r) => r) {
  const sdk = await import('../../ts/dist/index.js');
  const { shop } = await import('../../ts/dist/examples/shop.js');
  const check = await import(`${THEME}/consent-check.ts`);
  const [principal, agent] = await Promise.all([sdk.keyPair(), sdk.keyPair()]);
  const t = sdk.local(shop({ trust: [principal.public] }));
  const commits = [];
  const client = new sdk.Client(
    {
      ...t,
      async request(f, on) {
        if (f.verb === 'COMMIT') {
          commits.push(f);
        }

        return edit(await t.request(f, on));
      },
    },
    {
      key: agent.seed,
      grants: [
        await sdk.issueGrant({
          principal,
          to: agent.public,
          caveats: [
            { each: { of: 'spend', max: 1000, scale: 2, unit: 'USD' } },
          ],
        }),
      ],
    },
  );
  const r = await client.intent('shop.order', {
    items: [{ sku: 'm001', qty: 4 }],
    deliver: '2030-01-01',
  });

  assert.equal(r.kind, 'PROPOSALS');

  const received = { ...r.proposals[0], service: 'shop' };
  const start = (proposal = received) =>
    check.startRound(sdk, { client, proposal, principal });

  return { check, received, commits, start };
}

/** The service's consent request, with `patch` applied. */
const consentSaying = (patch) => (r) =>
  r.kind === 'ERROR' && r.consent
    ? { ...r, consent: { ...r.consent, ...patch } }
    : r;

test("startRound: waits on the human with a consent built from the proposal, not the service's request", {
  skip,
}, async () => {
  const lie = { summary: 'something else', expires: 4_000_000_000 };
  const { check, received, commits, start } = await setup(consentSaying(lie));
  const started = await start();

  assert.ok('waiting' in started);
  assert.deepEqual(check.checkOf(started), {
    state: 'ok',
    consent: started.waiting.ask.request,
  });
  assert.equal(started.waiting.ask.request.summary, received.summary);
  assert.equal(started.waiting.ask.request.expires, received.expires);
  assert.equal(commits.length, 1);

  // Approving lets the round sign and commit once more.
  started.waiting.decide(true);

  const out = await started.waiting.done;

  assert.equal(out.kind, 'reply');
  assert.equal(out.reply.kind, 'RECEIPT');
  assert.equal(out.reply.receipt.proposal, received.id);
  assert.equal(commits.length, 2);
});

test('startRound: a decline ends the round with no second COMMIT', {
  skip,
}, async () => {
  const { commits, start } = await setup();
  const started = await start();

  started.waiting.decide(false);

  assert.equal((await started.waiting.done).kind, 'declined');
  assert.equal(commits.length, 1);
});

test('startRound: refuses a request that names another proposal, hash, capability or service, or a tampered proposal, and says why', {
  skip,
}, async () => {
  const refusals = [
    [{ proposal: 'p_x' }, 'names another proposal'],
    [{ hash: 'x' }, "hash isn't the proposal's"],
    [{ capability: 'shop.x' }, 'another capability'],
    [{ service: 'evil.example' }, 'names another service'],
  ];

  for (const [patch, why] of refusals) {
    const { check, commits, start } = await setup(consentSaying(patch));
    const started = await start();

    assert.equal(check.checkOf(started).state, 'refused', why);
    assert.match(check.checkOf(started).why, new RegExp(why));
    assert.equal(commits.length, 1, why);
  }

  // Shown one thing, bound to another: the round refuses it before anyone is asked.
  const { check, received, start } = await setup();
  const tampered = await start({ ...received, summary: '1 roll' });

  assert.match(check.checkOf(tampered).why, /doesn't match its hash/);
});
