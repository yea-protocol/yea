/**
 * Tests for the landing's pure logic: the policy sentence, the slip views, the evidence
 * chart's rows, and that the recorded exchange (landing/exchange.ts) still matches what the
 * core produces, apart from ids, hashes, keys and dates. They import TypeScript sources and
 * the built SDK, so they need Node's type stripping (22.18+) and `npm run build` first.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';

const LANDING = '../.vitepress/theme/components/landing';
const built = existsSync(new URL('../../ts/dist/index.js', import.meta.url));
const skip = process.features.typescript
  ? false
  : 'needs Node with type stripping (22.18+) to import .ts';

test('policySentence reads the example policy', { skip }, async () => {
  const { landingCaveats, policySentence } = await import(
    `${LANDING}/policy.ts`
  );
  const now = 1_790_000_000;

  assert.equal(
    policySentence(landingCaveats(now), now),
    'For the next 8 hours, your agent may take low-risk actions at shop.example that spend up to $40 each and $100 in total.',
  );
});

test('policySentence covers partial and unknown caveats', {
  skip,
}, async () => {
  const { policySentence } = await import(`${LANDING}/policy.ts`);

  assert.equal(
    policySentence([{ svc: ['a.example'] }], 0),
    'Your agent may take actions at a.example.',
  );
  assert.equal(
    policySentence(
      [
        { total: { of: 'spend', max: 1250, scale: 2, unit: 'USD' } },
        { can: ['x'] },
      ],
      0,
    ),
    'Your agent may take actions that spend up to $12.50 in total.',
  );
  assert.equal(
    policySentence([{ exp: 900 }, { risk: 'medium' }], 0),
    'For the next 15 minutes, your agent may take actions up to medium risk.',
  );
});

test('amount and span say limits and durations as a reader would', {
  skip,
}, async () => {
  const { amount, span } = await import(`${LANDING}/policy.ts`);

  assert.equal(
    amount({ of: 'spend', max: 4000, scale: 2, unit: 'USD' }),
    '$40',
  );
  assert.equal(amount({ of: 'emails', max: 3 }), '3 emails');
  assert.equal(
    amount({ of: 'storage', max: 5, unit: 'GB' }),
    '5 GB of storage',
  );
  assert.deepEqual(
    [span(3600), span(86400 * 2), span(60)],
    ['1 hour', '2 days', '1 minute'],
  );
});

test('costRows: deltas as published, bars on one zero-based scale', {
  skip,
}, async () => {
  const { costRows, deltaRange, dollars, percentChange } = await import(
    `${LANDING}/evidence.ts`
  );
  const { LIVE } = await import(`${LANDING}/numbers.ts`);
  const rows = costRows(LIVE.tasks);

  assert.deepEqual(
    rows.map((r) => r.delta),
    ['+9%', '+12%', '+3%', '+15%'],
  );
  assert.equal(Math.max(...rows.flatMap((r) => [r.restBar, r.yeaBar])), 100);
  assert.equal(rows[0].restBar, 81.7);
  assert.equal(deltaRange(LIVE.tasks), '3–15%');
  assert.deepEqual(
    [dollars(0.1), percentChange(1, 0.96), percentChange(1, 1)],
    ['$0.100', '-4%', '0%'],
  );
});

test('slip views: undo windows, uses and results', {
  skip: skip || (!built && 'needs npm run build'),
}, async () => {
  const sdk = await import('../../ts/dist/index.js');
  const { receiptView, slipView, utcMinute } = await import(
    `${LANDING}/slip-view.ts`
  );
  const p = {
    id: 'p_1',
    capability: 'x',
    summary: 'Do it',
    risk: 'low',
    undo: null,
    expires: 0,
    hash: 'h',
    effects: [{ op: 'delete', target: 'file/a' }],
  };
  const consent = {
    proposal: 'p_1',
    hash: 'h',
    service: 's.example',
    capability: 'x',
    principal: 'k',
    summary: '',
    expires: 0,
  };
  const v = slipView(sdk, p, consent, 'why');

  assert.equal(v.undo, "can't be undone");
  assert.equal(v.uses, 'nothing');
  assert.deepEqual(v.effects, ['- delete file/a']);
  assert.equal(utcMinute(0), '1970-01-01 00:00 UTC');
  assert.deepEqual(receiptView({ id: 'r', undo: null, result: { a: 1 } }), {
    id: 'r',
    undoUntil: null,
    result: ['a: 1'],
  });
});

/** The recorded exchange with everything that changes per run replaced by a placeholder. */
const stable = (x) =>
  JSON.stringify(x)
    .replace(/\b[pr]_[\w-]{8}\b/g, 'ID')
    .replace(/pg1\.[\w-]+/g, 'GRANT')
    .replace(/\b[\w-]{43}\b/g, 'HASH')
    .replace(
      /\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?Z| \d{2}:\d{2} UTC)?/g,
      'DATE',
    )
    .replace(/\\"exp\\":\d+/g, 'EXP');

test('the recorded exchange still matches the core', {
  skip: skip || (!built && 'needs npm run build'),
}, async () => {
  const { record } = await import('../scripts/landing-exchange.mjs');
  const { RECORDED } = await import(`${LANDING}/exchange.ts`);

  assert.equal(
    stable(await record()),
    stable(RECORDED),
    'rerun: node site/scripts/landing-exchange.mjs',
  );
});
