/**
 * Tests for the landing's logic: the policy sentence, the proposal facts and slip views, the
 * evidence chart's rows, the tones the hero band and the steps take, what happens when the
 * proposal, the undo window or the policy runs out, and that the recorded exchange (landing/exchange.ts) still matches what the core
 * produces, apart from ids, hashes, keys and times. They import TypeScript sources and the
 * built SDK, so they need Node's type stripping (22.18+) and `npm run build` first.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mock, test } from 'node:test';

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

test("policyTerms lists the example policy shortly, in the page's order", {
  skip,
}, async () => {
  const { landingCaveats } = await import(`${LANDING}/policy.ts`);
  const { policyTerms } = await import(`${LANDING}/policy-terms.ts`);

  assert.deepEqual(policyTerms(landingCaveats(1000), 1000), [
    { key: 'svc', text: 'shop.example and calendar.example' },
    { key: 'risk', text: 'low risk only' },
    { key: 'each', text: '$40 each' },
    { key: 'total', text: '$100 in total' },
    { key: 'exp', text: '8 hours' },
  ]);
  // Caveats the list doesn't say are left out; the order is the page's, not the grant's.
  assert.deepEqual(
    policyTerms([{ exp: 60 }, { can: ['x'] }, { risk: 'medium' }], 0),
    [
      { key: 'risk', text: 'up to medium risk' },
      { key: 'exp', text: '1 minute' },
    ],
  );
});

test("policyAnswer: the mark waits for the policy's message, and a run in flight", {
  skip,
}, async () => {
  const { LEAD, policyAnswer } = await import(`${LANDING}/thread.ts`);
  const msgs = (tone) =>
    Array.from({ length: 6 }, (_, i) => ({
      from: '',
      text: '',
      wire: '',
      tone: i === LEAD - 1 ? tone : 'plain',
    }));

  assert.equal(policyAnswer(msgs('amber'), LEAD - 1), null, 'not arrived yet');
  assert.equal(policyAnswer(msgs('amber'), LEAD), 'amber');
  assert.equal(policyAnswer(msgs('green'), 6), 'green');
  assert.equal(policyAnswer(msgs('plain'), 6), null, 'a run on its way');
  assert.equal(policyAnswer(msgs('amber'), 0), null, 'a replay starts over');
  assert.equal(policyAnswer([], 6), null, 'no thread');
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
  // While a run is on its way, nothing waits on the person yet.
  assert.equal(phaseTone('checking'), 'plain');
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

  // With nothing pressed and no anchor, it spreads from the centre to the farthest corner.
  assert.deepEqual(
    { x: flood.value.x, y: flood.value.y, r: flood.value.r },
    { x: 200, y: 150, r: 250 },
  );

  tone.value = 'red';
  await nextTick();

  // The new spread goes over the colour the cut-short one had nearly covered.
  assert.equal(base.value, 'green');

  // The replaced spread's element reports its cancellation; the new spread carries on.
  settle(first);
  assert.equal(flood.value?.to, 'red');
  assert.equal(base.value, 'green');

  settle(flood.value.key);
  assert.equal(flood.value, null);
  assert.equal(base.value, 'red');

  // A return to plain nobody pressed for (a run starting on its own) settles at once.
  tone.value = 'plain';
  await nextTick();
  assert.equal(flood.value, null);
  assert.equal(base.value, 'plain');

  // A change nobody pressed for spreads from the anchor it's given (the approval point).
  const t2 = ref('plain');
  const a2 = useFlood(t2, band, () => ({ x: 10, y: 20 }));

  t2.value = 'amber';
  await nextTick();
  assert.deepEqual([a2.flood.value.x, a2.flood.value.y], [10, 20]);
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
  // The service's reason names the term the page marks (scene.decides).
  const reasons = {
    each: /spend over the per-commit limit of 40\.00 USD/,
    risk: /risk medium exceeds ceiling low/,
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
      assert.match(a.waiting.reason, reasons[scene.decides], key);
    } else {
      // Within: the term it's marked for is the risk ceiling it stays under.
      assert.equal(scene.decides, 'risk', key);
      assert.equal(p.proposal.risk, 'low', key);
    }

    const { receipt } =
      a.outcome === 'asks' ? await s.approve(a.waiting) : a.done;

    // Whatever the path, the result can be undone.
    assert.equal((await s.undo(receipt.id)).receipt.undoes, receipt.id, key);
  }
});

/** A hero state with plain `{ value }` refs, as runScene reads and writes it. */
const heroState = (scene) =>
  Object.fromEntries(
    Object.entries({
      scene,
      phase: 'loading',
      live: true,
      progress: null,
      slip: null,
      receipt: null,
      undone: null,
      status: '',
      error: '',
    }).map(([k, value]) => [k, { value }]),
  );

test('thread: four messages from the frames, the answer coloured by where it lands', {
  skip,
}, async () => {
  const { thread } = await import(`${LANDING}/thread.ts`);
  const { SCENES } = await import(`${LANDING}/scenes.ts`);
  const base = {
    scene: SCENES.cancel,
    params: { event: 'Design review' },
    proposals: { count: 1, id: 'p_1', summary: 'Cancel it' },
    outcome: 'asks',
    answer: 'risk medium exceeds ceiling low',
  };
  const asked = thread(base);

  assert.deepEqual(
    asked.map((m) => m.from),
    [
      'You → your agent',
      'Your agent → calendar.example',
      'calendar.example → your agent',
      'Your policy, at calendar.example',
    ],
  );
  assert.equal(asked[0].text, "“Cancel tomorrow's design review.”");
  assert.equal(asked[0].wire, '');
  assert.equal(
    asked[1].wire,
    '→ INTENT calendar.cancel {"event":"Design review"}',
  );
  assert.equal(
    asked[2].text,
    'One proposal, with its effects up front. The agent picks it and commits.',
  );
  assert.equal(asked[2].wire, '← [p_1] Cancel it');
  assert.match(asked[3].text, /^The calendar rates cancelling as medium risk/);
  assert.equal(
    asked[3].wire,
    '✗ consent_required: risk medium exceeds ceiling low',
  );
  assert.equal(asked[3].tone, 'amber');

  const within = thread({ ...base, outcome: 'within', answer: 'r_1' });

  assert.equal(within[3].wire, '✓ receipt r_1');
  // Inside the policy, the service simply answers with the receipt.
  assert.equal(within[3].from, 'calendar.example → your agent');
  assert.equal(within[3].tone, 'green');

  // Before the service answers, it has said nothing, and nobody has committed.
  const early = thread({ ...base, proposals: null, outcome: null });

  assert.deepEqual([early[2].text, early[2].wire], ['', '']);

  // Before the commit is answered, the policy has said nothing.
  assert.deepEqual(
    [
      thread({ ...base, outcome: null }).at(-1).text,
      thread({ ...base, outcome: null }).at(-1).tone,
    ],
    ['', 'plain'],
  );
});

test('thread: the visitor approval, the receipt and the undo follow the policy answer', {
  skip,
}, async () => {
  const { thread } = await import(`${LANDING}/thread.ts`);
  const { SCENES } = await import(`${LANDING}/scenes.ts`);
  const p = {
    scene: SCENES.dinner,
    params: {},
    proposals: { count: 2, id: 'p_1', summary: '4 meals' },
    outcome: 'asks',
    answer: 'over the limit',
  };
  const approved = { id: 'r_1', undoUntil: '2026-09-30 14:00 UTC' };
  const all = thread(p, { approved, undone: { id: 'r_2', undoes: 'r_1' } });

  assert.equal(all.length, 7);
  assert.deepEqual(
    all.slice(4).map((m) => m.wire),
    [
      '→ COMMIT p_1 + your consent grant',
      '✓ receipt r_1',
      '↶ undid r_1 (receipt r_2)',
    ],
  );
  assert.equal(
    all[5].text,
    'Order placed. It can be undone until 2026-09-30 14:00 UTC.',
  );
  // Inside the policy there's nothing to approve: the receipt is the policy's answer.
  assert.equal(
    thread(
      { ...p, outcome: 'within', answer: 'r_1' },
      { approved, undone: null },
    ).length,
    4,
  );
});

test('playhead: messages arrive in turn, the slip after the fourth; Replay keeps it', {
  skip,
}, async () => {
  const { FIRST_MS, NEXT_MS, playhead, SLIP_MS } = await import(
    `${LANDING}/playhead.ts`
  );

  mock.timers.enable({ apis: ['setTimeout'] });

  // The mock clock fires only timers set before a tick; each beat sets the next, so step.
  const advance = (ms) => {
    for (let t = 0; t < ms; t += 50) {
      mock.timers.tick(50);
    }
  };

  try {
    let count = 4;
    const p = playhead({
      count: () => count,
      autoplay: () => true,
      replayable: () => true,
    });

    p.clear();
    assert.deepEqual(
      [p.reveal.value, p.playing.value, p.landed.value],
      [0, true, false],
    );

    p.play();
    advance(FIRST_MS + 3 * NEXT_MS);
    assert.deepEqual([p.reveal.value, p.landed.value], [4, false]);

    // The slip arrives a beat after the fourth message, and the play ends.
    advance(SLIP_MS);
    assert.deepEqual([p.landed.value, p.playing.value], [true, false]);

    // Replay plays the messages again and never sends the slip away; messages the visitor
    // adds meanwhile (an approval) play too.
    p.play(true);
    assert.deepEqual([p.reveal.value, p.landed.value], [0, true]);
    count = 6;
    advance(FIRST_MS + 5 * NEXT_MS);
    assert.deepEqual(
      [p.reveal.value, p.playing.value, p.landed.value],
      [6, false, true],
    );

    // Skip mid-play shows it all and stops the clock.
    p.play(true);
    advance(FIRST_MS);
    p.show();
    advance(10 * NEXT_MS);
    assert.deepEqual([p.reveal.value, p.playing.value], [1, false]);
  } finally {
    mock.timers.reset();
  }
});

test('playhead: out of view, or without autoplay, a landing run just shows', {
  skip,
}, async () => {
  const { playhead } = await import(`${LANDING}/playhead.ts`);
  let auto = true;
  const p = playhead({
    count: () => 4,
    autoplay: () => auto,
    replayable: () => true,
  });

  p.clear();
  p.seen(false);
  p.play();
  assert.deepEqual([p.playing.value, p.landed.value], [false, true]);

  // Asked for, Replay plays even out of view: the press proves it is seen.
  p.play(true);
  assert.equal(p.playing.value, true);
  p.stop();

  // Without autoplay (one column, or reduced motion), a run never clears the thread.
  auto = false;
  p.show();
  p.clear();
  assert.deepEqual([p.playing.value, p.landed.value], [false, true]);
});

test('onPhase: a run starting clears the thread, landing plays it, failing shows it', {
  skip,
}, async () => {
  const { onPhase } = await import(`${LANDING}/thread.ts`);

  assert.equal(onPhase('waiting', 'checking'), 'clear');
  assert.equal(onPhase('checking', 'waiting'), 'play');
  assert.equal(onPhase('checking', 'committed'), 'play');
  assert.equal(onPhase('checking', 'error'), 'show');
  assert.equal(onPhase('loading', 'unavailable'), 'show');
  // The visitor's own steps don't replay anything.
  assert.equal(onPhase('waiting', 'approving'), null);
  assert.equal(onPhase('approving', 'committed'), null);
  assert.equal(onPhase('undoing', 'undone'), null);
});

test('junction: lines arrive level; the proposals not picked branch off and stop', {
  skip,
}, async () => {
  const { branches, converge } = await import(`${LANDING}/junction.ts`);

  assert.equal(
    converge({ x: 0, y: 10 }, { x: 200, y: 50 }),
    'M0 10 C110 10 90 50 200 50',
  );
  assert.deepEqual(
    branches({ x: 0, y: 100 }, 3, 80).map((b) => b.end),
    [
      { x: 80, y: 70 },
      { x: 80, y: 130 },
      { x: 80, y: 40 },
    ],
  );
  assert.deepEqual(branches({ x: 0, y: 0 }, 0, 80), []);
});

test('runScene: a run a newer one replaced writes nothing; a failed run says why', {
  skip: needsCore,
}, async () => {
  const sdk = await import('../../ts/dist/index.js');
  const { shop } = await import('../../ts/dist/examples/shop.js');
  const { calendar } = await import('../../ts/dist/examples/calendar.js');
  const { runScene } = await import(`${LANDING}/run-scene.ts`);
  const live = {
    sdk,
    services: { shop, calendar },
    session: null,
    waiting: null,
    run: 0,
  };
  const state = heroState('dinner');
  const first = runScene(state, live);

  // Busy from the first moment: nothing from before can show or be pressed.
  assert.equal(state.phase.value, 'checking');

  // The visitor picks another example while the first run is still starting.
  state.scene.value = 'move';
  await Promise.all([first, runScene(state, live)]);

  assert.equal(state.progress.value.scene.key, 'move');
  assert.equal(state.phase.value, 'committed');
  assert.equal(live.waiting, null);

  // The session is the second run's: its receipt can be undone through it.
  const r = state.receipt.value.id;

  assert.equal((await live.session.undo(r)).receipt.undoes, r);

  const broken = {
    ...live,
    services: {
      shop: () => {
        throw new Error('the shop is down');
      },
      calendar,
    },
    run: 0,
  };
  const failed = heroState('dinner');

  await runScene(failed, broken);
  assert.equal(failed.phase.value, 'error');
  assert.equal(failed.error.value, 'the shop is down');
  assert.match(failed.status.value, /Start again/);
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
