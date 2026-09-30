/**
 * Tests for the landing's logic: the policy sentence, the proposal facts and slip views, the
 * evidence chart's rows, the tones the hero band and the steps take, what happens when the
 * proposal, the undo window or the policy runs out, and that the recorded exchange (landing/exchange.ts) still matches what the core
 * produces, apart from ids, hashes, keys and times. They import TypeScript sources and the
 * built SDK, so they need Node's type stripping (22.18+) and `npm run build` first.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';

const LANDING = '../.vitepress/theme/components/landing';
const built = existsSync(new URL('../../ts/dist/index.js', import.meta.url));
const skip = process.features.typescript
  ? false
  : 'needs Node with type stripping (22.18+) to import .ts';
const needsCore = skip || (!built && 'needs npm run build');
const usd = (cents) => ({ of: 'spend', max: cents, scale: 2, unit: 'USD' });

test('policySentence reads the example policy', { skip }, async () => {
  const { landingCaveats, policySentence } = await import(
    `${LANDING}/policy.ts`
  );
  const now = 1_790_000_000;

  assert.equal(
    policySentence(landingCaveats(now), now),
    'For the next 8 hours, your agent may take low-risk actions at shop.example or calendar.example that spend up to $40 each and $100 in total.',
  );
});

test('policySentence: partial, unknown and non-spend caveats', {
  skip,
}, async () => {
  const { policySentence } = await import(`${LANDING}/policy.ts`);

  assert.equal(
    policySentence([{ svc: ['a.example'] }], 0),
    'Your agent may take actions at a.example.',
  );
  assert.equal(
    policySentence([{ total: usd(1250) }, { can: ['x'] }], 0),
    'Your agent may take actions that spend up to $12.50 in total.',
  );
  assert.equal(
    policySentence(
      [{ each: { of: 'emails', max: 3 } }, { total: usd(1000) }],
      0,
    ),
    'Your agent may take actions that use up to 3 emails each and spend up to $10 in total.',
  );
  assert.equal(
    policySentence([{ exp: 900 }, { risk: 'medium' }], 0),
    'For the next 15 minutes, your agent may take actions up to medium risk.',
  );
});

test('phaseTone: the hero band waits in amber, commits in green, and goes plain after', {
  skip,
}, async () => {
  const { phaseTone } = await import(`${LANDING}/tone.ts`);
  const tones = (phases) => phases.map(phaseTone);

  // The page first paints the recorded proposal, which is waiting on the person.
  assert.deepEqual(tones(['loading', 'waiting', 'approving']), [
    'amber',
    'amber',
    'amber',
  ]);
  // While a run leads up to its outcome, nothing waits on the person yet.
  assert.deepEqual(tones(['asking', 'proposed', 'checking']), [
    'plain',
    'plain',
    'plain',
  ]);
  assert.deepEqual(tones(['committed', 'undoing']), ['green', 'green']);
  // If the core can't start, nothing waits on anyone.
  assert.deepEqual(tones(['unavailable', 'undone', 'expired', 'error']), [
    'plain',
    'plain',
    'plain',
    'red',
  ]);
});

test('useFlood: a spread cut short by the next one never settles it early', {
  skip,
}, async () => {
  const { nextTick, ref } = await import('vue');
  const { useFlood } = await import(`${LANDING}/use-flood.ts`);
  const box = { left: 0, top: 0, width: 400, height: 300 };
  const band = ref({ getBoundingClientRect: () => box });
  const tone = ref('amber');
  const { base, flood, settle } = useFlood(tone, band);

  tone.value = 'green';
  await nextTick();

  const first = flood.value.key;

  // With nothing pressed, it spreads from the centre to the farthest corner.
  assert.deepEqual(
    { x: flood.value.x, y: flood.value.y, r: flood.value.r },
    { x: 200, y: 150, r: 250 },
  );

  tone.value = 'plain';
  await nextTick();

  // The new spread goes over the colour the cut-short one had nearly covered.
  assert.equal(base.value, 'green');

  // The replaced spread's element reports its cancellation; the new spread carries on.
  settle(first);
  assert.equal(flood.value?.to, 'plain');
  assert.equal(base.value, 'green');

  settle(flood.value.key);
  assert.equal(flood.value, null);
  assert.equal(base.value, 'plain');
});

test('each protocol state step takes the tone of the state it shows', {
  skip,
}, async () => {
  const { STATES } = await import(`${LANDING}/states.ts`);

  assert.deepEqual(Object.fromEntries(STATES.map((s) => [s.key, s.tone])), {
    intent: 'plain',
    proposal: 'amber',
    policy: 'plain',
    consent: 'amber',
    receipt: 'green',
  });
});

test('amount and span say limits and durations as a reader would', {
  skip,
}, async () => {
  const { amount, span } = await import(`${LANDING}/policy.ts`);

  assert.equal(amount(usd(4000)), '$40');
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

test('proposal facts: one wording for the slip and the consent card', {
  skip: needsCore,
}, async () => {
  const sdk = await import('../../ts/dist/index.js');
  const { factsLine, proposalFacts } = await import(
    '../.vitepress/theme/components/proposal-facts.ts'
  );
  const f = proposalFacts(sdk, {
    effects: [{ op: 'delete', target: 'file/a' }],
    risk: 'low',
    undo: { window: 7200 },
    uses: { spend: { amount: 5395, scale: 2, unit: 'USD' } },
  });

  assert.deepEqual(f.effects, ['- delete file/a']);
  assert.equal(factsLine(f), 'Uses spend 53.95 USD, risk low, undo within 2h');
  assert.equal(
    factsLine({
      effects: [],
      uses: null,
      risk: 'high',
      undo: "can't be undone",
    }),
    "Risk high, can't be undone",
  );
});

test('slip views: undo windows, uses, results and whole dates', {
  skip: needsCore,
}, async () => {
  const sdk = await import('../../ts/dist/index.js');
  const { keepDates, receiptView, slipView, spendOf, utcClock } = await import(
    `${LANDING}/slip-view.ts`
  );
  const p = {
    id: 'p_1',
    summary: 'Do it',
    risk: 'low',
    undo: null,
    expires: 60,
    effects: [],
  };
  const v = slipView(sdk, p, { service: 's.example', hash: 'h', reason: '' });

  assert.deepEqual(
    [v.undo, v.uses, v.expires, v.service, v.hash, v.reason],
    ["can't be undone", 'nothing', 60, 's.example', 'h', ''],
  );
  assert.equal(utcClock(0), '00:00 UTC');
  assert.equal(
    spendOf({ uses: { spend: { amount: 5395, scale: 2, unit: 'USD' } } }),
    53.95,
  );
  assert.equal(spendOf({}), null);
  assert.deepEqual(receiptView({ id: 'r', undo: null, result: { a: 1 } }), {
    id: 'r',
    until: null,
    undoUntil: null,
    result: ['a: 1'],
  });
  assert.deepEqual(keepDates('4 meals for 2026-09-29 — 53.95 USD'), [
    { text: '4 meals for ', date: false },
    { text: '2026-09-29', date: true },
    { text: ' — 53.95 USD', date: false },
  ]);
});

test('lapsed: the policy first, then the waiting proposal or the open undo window', {
  skip,
}, async () => {
  const { lapsed, lapseText } = await import(`${LANDING}/expiry.ts`);

  assert.equal(lapsed(100, { grant: 200, proposal: 150, undo: null }), null);
  assert.equal(lapsed(150, { grant: 200, proposal: 150 }), 'proposal');
  assert.equal(lapsed(160, { grant: 200, undo: 150 }), 'undo');
  assert.equal(lapsed(250, { grant: 200, proposal: 150 }), 'policy');
  assert.match(
    lapseText('proposal', '20:44 UTC'),
    /expired at 20:44 UTC.*Start again/,
  );
});

/** Run `fn` with Date.now moved `seconds` ahead, as the core and the shop see it. */
async function later(seconds, fn) {
  const real = Date.now;

  Date.now = () => real() + seconds * 1000;

  try {
    return await fn();
  } finally {
    Date.now = real;
  }
}

test('the session says in words when a proposal, an undo window or the policy ran out', {
  skip: needsCore,
}, async () => {
  const sdk = await import('../../ts/dist/index.js');
  const { shop } = await import('../../ts/dist/examples/shop.js');
  const { landingCaveats } = await import(`${LANDING}/policy.ts`);
  const { Session } = await import(`${LANDING}/session.ts`);
  const { SCENES, tomorrow } = await import(`${LANDING}/scenes.ts`);
  const dinner = SCENES.dinner;
  const now = Math.floor(Date.now() / 1000);
  const s = await Session.start(sdk, shop, landingCaveats(now));
  const ask = async () => {
    const a = await s.commit(
      await s.propose(dinner.capability, dinner.params(tomorrow())),
    );

    assert.equal(a.outcome, 'asks');

    return a.waiting;
  };

  assert.equal(s.grantExpires, now + 8 * 3600);

  const w = await ask();

  await assert.rejects(
    later(w.proposal.expires - now + 1, () => s.approve(w)),
    /^Error: It didn't go through: .*expired/,
  );

  const done = await s.approve(await ask());

  await assert.rejects(
    later(7201, () => s.undo(done.receipt.id)),
    /^Error: The undo didn't go through: the undo window closed/,
  );

  const p = await s.propose(dinner.capability, dinner.params(tomorrow()));

  await assert.rejects(
    later(8 * 3600 + 1, () => s.commit(p)),
    /^Error: The commit didn't go through: grant has expired/,
  );
});

test('each example lands where the page says under the one policy it signs', {
  skip: needsCore,
}, async () => {
  const sdk = await import('../../ts/dist/index.js');
  const { shop } = await import('../../ts/dist/examples/shop.js');
  const { calendar } = await import('../../ts/dist/examples/calendar.js');
  const { landingCaveats } = await import(`${LANDING}/policy.ts`);
  const { Session } = await import(`${LANDING}/session.ts`);
  const { SCENE_KEYS, SCENES, tomorrow } = await import(`${LANDING}/scenes.ts`);
  const services = { shop, calendar };
  const expected = { dinner: 'asks', cancel: 'asks', move: 'within' };
  const reasons = {
    dinner: /spend over the per-commit limit of 40\.00 USD/,
    cancel: /risk medium exceeds ceiling low/,
  };

  assert.deepEqual([...SCENE_KEYS], Object.keys(expected));

  for (const key of SCENE_KEYS) {
    const scene = SCENES[key];
    const s = await Session.start(
      sdk,
      services[scene.service],
      landingCaveats(Math.floor(Date.now() / 1000)),
    );
    const p = await s.propose(scene.capability, scene.params(tomorrow()));
    const a = await s.commit(p);

    assert.equal(a.outcome, expected[key], key);
    assert.equal(p.proposal.id.startsWith('p_'), true);

    if (a.outcome === 'asks') {
      assert.match(a.waiting.reason, reasons[key]);
    }

    const { receipt } =
      a.outcome === 'asks' ? await s.approve(a.waiting) : a.done;

    // Whatever the path, the result can be undone.
    assert.equal((await s.undo(receipt.id)).receipt.undoes, receipt.id, key);
  }
});

test('stops: the lead-up says each stop from the frames, and the outcome once known', {
  skip,
}, async () => {
  const { stops } = await import(`${LANDING}/trail.ts`);
  const { SCENES } = await import(`${LANDING}/scenes.ts`);
  const base = {
    scene: SCENES.cancel,
    params: { event: 'Design review' },
    proposals: null,
    outcome: null,
    answer: '',
  };
  const start = stops(base);

  assert.deepEqual(
    start.map((s) => s.label),
    ['Agent asks', 'Service proposes', 'Policy checks', 'You decide'],
  );
  assert.equal(
    start[0].wire,
    '→ INTENT calendar.cancel {"event":"Design review"}',
  );
  // Stops the run hasn't reached say nothing yet.
  assert.deepEqual([start[1].text, start[3].wire], ['', '']);

  const proposals = { count: 1, id: 'p_1', summary: 'Cancel it' };
  const asked = stops({
    ...base,
    proposals,
    outcome: 'asks',
    answer: 'risk medium exceeds ceiling low',
  });

  assert.match(asked[1].text, /answers with a proposal, .* picks it\./);
  assert.equal(asked[2].wire, '→ COMMIT p_1');
  assert.match(asked[3].text, /^Cancelling emails two people/);
  assert.equal(
    asked[3].wire,
    '✗ consent_required: risk medium exceeds ceiling low',
  );

  const within = stops({
    ...base,
    proposals,
    outcome: 'within',
    answer: 'r_1',
  });

  assert.equal(within[3].label, 'Goes ahead');
  assert.equal(within[3].wire, '✓ receipt r_1');
});

/** The recorded exchange with everything that changes per run replaced by a placeholder. */
const stable = (x) =>
  JSON.stringify(x)
    .replace(/(?<![\w-])[pr]_[\w-]{8}(?![\w-])/g, 'ID')
    .replace(/pg1\.[\w-]+/g, 'GRANT')
    .replace(/(?<![\w-])[\w-]{43}(?![\w-])/g, 'HASH')
    .replace(
      /\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?Z| \d{2}:\d{2} UTC)?/g,
      'DATE',
    )
    .replace(/\\"exp\\":\d+/g, 'EXP')
    .replace(/"(expires|until)":\d+/g, '"$1":TIME');

test('the recorded exchange still matches the core', {
  skip: needsCore,
}, async () => {
  const { record } = await import('../scripts/landing-exchange.mjs');
  const { RECORDED } = await import(`${LANDING}/exchange.ts`);
  const fresh = await record();

  assert.equal(fresh.spend, 53.95);
  assert.equal(RECORDED.spend, fresh.spend);
  assert.equal(
    stable(fresh),
    stable(RECORDED),
    'rerun: node site/scripts/landing-exchange.mjs',
  );
});
