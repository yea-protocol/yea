/**
 * Generates ../conformance/job-calls.json (docs/framework/SPEC-approval.md, "How a job call
 * runs") from the reference: each call is a sequence of rounds of the job call session, with the
 * store before and after each one and its outcome. Run by vectors.mjs. Every step's outcome kind
 * is asserted before it's written.
 */
import * as P from '../dist/index.js';
import { runCall } from './job-call-run.mjs';

const seed = (n) => P.b64u(new Uint8Array(32).fill(n));
const now = 1790000000;
const principal = await P.keyPair(seed(1));
const server = await P.keyPair(seed(5));

const refund = {
  summary: 'Refund 30.00 USD to Chen',
  effects: [
    { op: 'create', target: 'refund', detail: '30.00 USD to card ••42' },
  ],
  uses: { spend: { amount: 3000, scale: 2, unit: 'USD' } },
  risk: 'low',
  undoWindow: 60,
};
const credit = {
  summary: 'Give Chen 30.00 USD of store credit',
  effects: [{ op: 'create', target: 'credit', detail: '30.00 USD' }],
  risk: 'low',
  undoWindow: 60,
};
const tool = { name: 'refund', revert: true };
const input = { who: 'Chen', order: 42 };
const [refundHp, creditHp] = await P.hashPlans(tool, input, [
  { ...refund, apply: () => null },
  { ...credit, apply: () => null },
]);

const policyGrant = await P.issueGrant({
  principal,
  to: server.public,
  iat: now - 100,
  nonce: 'job-calls-policy',
  caveats: [
    { can: ['refund'] },
    { risk: 'low' },
    { total: { of: 'spend', max: 5000, scale: 2, unit: 'USD' } },
    { exp: now + 3600 },
  ],
});
const spendKey = `${await P.sha256(P.decodeGrant(policyGrant)[0].s)} spend`;
const consentGrant = await P.issueGrant({
  principal,
  to: server.public,
  iat: now,
  nonce: 'job-calls-consent',
  caveats: [
    { svc: [server.public] },
    { verbs: ['COMMIT'] },
    { can: ['refund'] },
    { only: refundHp.planHash },
    { exp: now + 600 },
  ],
});
const consentId = await P.sha256(P.decodeGrant(consentGrant)[0].s);

/** The person's standing rules: no signed policy unless `grant` is given. */
const policy = (o = {}) => ({
  grant: null,
  principal: principal.public,
  server: server.public,
  deny: [],
  outOfBand: 'high',
  ...o,
});
const allowed = policy({ grant: policyGrant });
const cents = (n) => String(P.exact({ amount: n, scale: 2 }));

/** A round's facts: a first call at `now` from a client that can ask, unless `o` says otherwise. */
const step = (expect, o = {}) => ({
  expect,
  now,
  sub: '',
  input,
  canAsk: true,
  plans: [refund],
  policy: policy(),
  ...o,
});
const accept = (confirm, plan) => ({
  action: 'accept',
  content: { confirm, ...(plan ? { plan } : {}) },
});
const retry = (fromStep, answer) => ({ state: { fromStep }, answer });
const empty = { used: {}, consumed: [] };

const calls = [
  {
    name: 'a denied tool is refused before its handler runs, even on preview',
    before: empty,
    steps: [
      step('refuse', { preview: true, policy: policy({ deny: ['refund'] }) }),
      step('refuse', { policy: policy({ deny: ['refund'] }) }),
    ],
  },
  {
    name: 'preview shows the plans; nothing runs and nothing is stored',
    before: { used: { [spendKey]: '0' }, consumed: [] },
    steps: [step('preview', { preview: true, policy: allowed })],
  },
  {
    name: 'inside the policy, the first plan runs and reserves its total',
    before: { used: { [spendKey]: cents(1000) }, consumed: [] },
    steps: [step('run', { plans: [refund, credit], policy: allowed })],
  },
  {
    name: 'a limit that fills up between decide and reserve asks, and holds nothing',
    before: { used: { [spendKey]: cents(1000) }, consumed: [] },
    steps: [
      step('ask', {
        policy: allowed,
        race: [{ key: spendKey, amount: cents(1500) }],
      }),
    ],
  },
  {
    name: 'past a total, the call asks',
    before: { used: { [spendKey]: cents(3000) }, consumed: [] },
    steps: [step('ask', { policy: allowed })],
  },
  {
    name: 'asking, then the right phrase runs the chosen plan',
    tool: { ...tool, phrases: { [creditHp.planHash]: 'credit Chen' } },
    before: empty,
    steps: [
      step('ask', { plans: [refund, credit] }),
      step('run', {
        plans: [refund, credit],
        retry: retry(1, accept(' Credit chen ', creditHp.planHash)),
      }),
    ],
  },
  {
    name: 'a wrong phrase asks again, and the third wrong one refuses',
    before: empty,
    steps: [
      step('ask'),
      step('ask', { retry: retry(1, accept('yes')) }),
      step('ask', { retry: retry(2, accept('ok')) }),
      step('refuse', { retry: retry(3, accept('sure')) }),
    ],
  },
  {
    name: 'a replayed state runs nothing',
    before: empty,
    steps: [
      step('ask'),
      step('run', { retry: retry(1, accept('approve')) }),
      step('refuse', { retry: retry(1, accept('approve')) }),
    ],
  },
  {
    name: 'a declined answer runs nothing, and its state is used up',
    before: empty,
    steps: [
      step('ask'),
      step('refuse', { retry: retry(1, { action: 'decline' }) }),
      step('refuse', { retry: retry(1, accept('approve')) }),
    ],
  },
  {
    name: 'a state for another input, or past its expiry, runs nothing',
    before: empty,
    steps: [
      step('ask'),
      step('refuse', {
        input: { who: 'Ana', order: 42 },
        retry: retry(1, accept('approve')),
      }),
      step('refuse', { now: now + 600, retry: retry(1, accept('approve')) }),
    ],
  },
  {
    name: 'plans that changed since the form ask again',
    before: empty,
    steps: [
      step('ask'),
      step('ask', { plans: [credit], retry: retry(1, accept('approve')) }),
    ],
  },
  {
    name: 'a chosen plan now at or above outOfBand gets a consent code instead',
    before: empty,
    steps: [
      step('ask'),
      step('consent-codes', {
        policy: policy({ outOfBand: 'low' }),
        retry: retry(1, accept('approve')),
      }),
    ],
  },
  {
    name: 'a consent code consumed twice runs its plan once',
    consents: { [refundHp.planHash]: consentGrant },
    before: empty,
    steps: [
      step('run', { canAsk: false }),
      step('consent-codes', { canAsk: false }),
    ],
  },
  {
    name: 'a consent already consumed counts as absent, so the call asks',
    consents: { [refundHp.planHash]: consentGrant },
    before: { used: {}, consumed: [consentId] },
    steps: [step('ask')],
  },
  {
    name: 'with no pinned principal key, no consent code is offered',
    consents: { [refundHp.planHash]: consentGrant },
    before: empty,
    steps: [
      step('consent-codes', {
        canAsk: false,
        policy: policy({ principal: '' }),
        unpinned: 'YEA_PRINCIPAL_PUB is not set',
      }),
    ],
  },
  {
    name: 'a plan at or above outOfBand is listed but not offered in the form',
    before: empty,
    steps: [step('ask', { plans: [{ ...refund, risk: 'high' }, credit] })],
  },
  {
    name: 'a clarification is returned as it is',
    before: empty,
    steps: [
      step('clarify', {
        plans: P.clarify('Which order?', [
          { label: 'Order 42', params: { order: 42 } },
          { label: 'Order 43', params: { order: 43 } },
        ]),
      }),
    ],
  },
  {
    name: 'no plans refuses the call',
    before: empty,
    steps: [step('refuse', { plans: [] })],
  },
];

/** Run each call, check each step's outcome kind, and write what it did into the steps. */
async function generate() {
  const out = [];

  for (const c of calls) {
    const spec = {
      name: c.name,
      tool: c.tool ?? tool,
      ...(c.consents ? { consents: c.consents } : {}),
      steps: c.steps.map(({ expect: _kind, ...facts }, i) => ({
        ...facts,
        ...(i === 0 ? { before: c.before } : {}),
      })),
    };
    const done = await runCall(P, spec);

    c.steps.forEach((s, i) => {
      if (done[i].outcome.kind !== s.expect) {
        throw new Error(
          `job call "${c.name}" step ${i + 1}: expected ${s.expect}, got ${JSON.stringify(done[i].outcome)}`,
        );
      }
    });
    out.push({
      ...spec,
      steps: spec.steps.map((facts, i) => ({ ...facts, ...done[i] })),
    });
  }

  return out;
}

export const jobCalls = {
  keys: { principal: principal.public, server: server.public },
  calls: await generate(),
};
