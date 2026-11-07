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
    { only: await P.consentHashOf(refundHp.planHash, 'approve') },
    { exp: now + 600 },
  ],
});
const consentId = await P.sha256(P.decodeGrant(consentGrant)[0].s);
/** The refund's consent, signed by the server's own key instead of the principal's. */
const forgedConsent = await P.issueGrant({
  principal: server,
  to: server.public,
  iat: now,
  nonce: 'job-calls-forged',
  caveats: P.decodeGrant(consentGrant)[0].p.caveats,
});
/** The refund's consent, signed by the principal but issued to another key than the server's. */
const elsewhereConsent = await P.issueGrant({
  principal,
  to: (await P.keyPair(seed(9))).public,
  iat: now,
  nonce: 'job-calls-elsewhere',
  caveats: P.decodeGrant(consentGrant)[0].p.caveats,
});

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
/** The reason a call gives when a stored consent was signed for another phrase (§6). */
const phraseChanged = 'consent for this plan was signed for a different phrase';
/** The reason a call gives when the consent it carries can't be used (§6). */
const carried = (why) =>
  `the consent passed as yea_consent can't be used: ${why}`;

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
    name: 'a consent signed for another phrase counts as absent, and the form and codes say so',
    tool: { ...tool, phrases: { [refundHp.planHash]: 'refund Chen' } },
    consents: { [refundHp.planHash]: consentGrant },
    before: empty,
    steps: [
      step('ask', { says: phraseChanged }),
      step('consent-codes', { canAsk: false, says: phraseChanged }),
    ],
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
    name: 'a consent on the call runs its plan once, and a second use asks',
    before: empty,
    steps: [
      step('run', { consent: consentGrant }),
      step('consent-codes', {
        canAsk: false,
        consent: consentGrant,
        says: carried('it was already used'),
      }),
    ],
  },
  {
    name: 'a consent on the call for another plan asks, and never falls through to the policy',
    before: { used: { [spendKey]: '0' }, consumed: [] },
    steps: [
      step('ask', {
        plans: [credit],
        policy: allowed,
        consent: consentGrant,
        says: carried('it approves none of these plans'),
      }),
    ],
  },
  {
    name: 'a mangled, expired or forged consent on the call asks, and says why',
    before: empty,
    steps: [
      step('ask', {
        consent: consentGrant.slice(0, 60),
        says: carried("it isn't a consent from yea approve"),
      }),
      step('consent-codes', {
        canAsk: false,
        now: now + 600,
        consent: consentGrant,
        says: carried('it has expired'),
      }),
      step('consent-codes', {
        canAsk: false,
        consent: forgedConsent,
        says: carried(
          "it isn't signed by the pinned principal for this tool at this server",
        ),
      }),
      step('consent-codes', {
        canAsk: false,
        consent: elsewhereConsent,
        says: carried(
          "it isn't signed by the pinned principal for this tool at this server",
        ),
      }),
    ],
  },
  {
    name: 'a consent on the call keeps working with the newline a terminal copy adds',
    before: empty,
    steps: [step('run', { consent: ` ${consentGrant}\r\n` })],
  },
  {
    name: 'with no pinned principal key, a consent on the call counts for nothing',
    before: empty,
    steps: [
      step('consent-codes', {
        canAsk: false,
        policy: policy({ principal: '' }),
        unpinned: 'YEA_PRINCIPAL_PUB is not set',
        consent: consentGrant,
        says: carried('YEA_PRINCIPAL_PUB is not set'),
      }),
    ],
  },
  {
    name: 'a preview and a retry ignore a consent on the call',
    before: empty,
    steps: [
      step('preview', { preview: true, consent: consentGrant }),
      step('ask', { consent: 'pg1.nope' }),
      step('run', {
        consent: 'pg1.nope',
        retry: retry(2, accept('approve')),
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
    name: 'no plans refuses the call, with or without a consent on it',
    before: empty,
    steps: [
      step('refuse', { plans: [] }),
      step('refuse', {
        plans: [],
        consent: consentGrant,
        says: 'has no way to do this',
      }),
    ],
  },
];

/** Run each call, check each step's outcome (its kind, and any text it `says`), and record it. */
async function generate() {
  const out = [];

  for (const c of calls) {
    const spec = {
      name: c.name,
      tool: c.tool ?? tool,
      ...(c.consents ? { consents: c.consents } : {}),
      steps: c.steps.map(({ expect: _kind, says: _says, ...facts }, i) => ({
        ...facts,
        ...(i === 0 ? { before: c.before } : {}),
      })),
    };
    const done = await runCall(P, spec);

    c.steps.forEach((s, i) => {
      const got = JSON.stringify(done[i].outcome);

      if (done[i].outcome.kind !== s.expect || !got.includes(s.says ?? '')) {
        throw new Error(
          `job call "${c.name}" step ${i + 1}: expected ${s.expect}, got ${got}`,
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
