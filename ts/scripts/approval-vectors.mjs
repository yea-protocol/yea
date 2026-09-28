// Generates ../conformance/approval.json (docs/framework/SPEC-approval.md) from the reference.
// Run by vectors.mjs. Every case asserts the outcome the spec requires before it's written.
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import * as P from '../dist/index.js';
import { FileStore } from '../dist/node.js';

const seed = (n) => P.b64u(new Uint8Array(32).fill(n));
const now = 1790000000;
const principal = await P.keyPair(seed(1));
const server = await P.keyPair(seed(5));
const other = await P.keyPair(seed(6));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const must = (name, got, want) => {
  if (!same(got, want)) {
    throw new Error(
      `approval case ${name}: expected ${JSON.stringify(want)} got ${JSON.stringify(got)}`,
    );
  }
};

// ---- plans ----
const plans = {
  move: {
    tool: { name: 'reschedule', revert: true },
    plan: {
      summary: 'Move "1:1 with Ana" to Thu 15:00',
      effects: [
        {
          op: 'update',
          target: 'event/e42',
          field: 'start',
          from: '14:00',
          to: '15:00',
        },
      ],
      risk: 'low',
      undoWindow: 3600,
    },
  },
  email: {
    tool: { name: 'send_email', risk: 'low' },
    plan: {
      summary: 'Email the team the notes',
      effects: [{ op: 'send', target: 'team@example.com' }],
      uses: { emails: { amount: 1 } },
    },
  },
  emailUndoable: {
    tool: { name: 'send_email', revert: true },
    plan: {
      summary: 'Schedule the notes email',
      effects: [{ op: 'create', target: 'scheduled/1' }],
      uses: { emails: { amount: 1 } },
      risk: 'low',
      undoWindow: 600,
    },
  },
  refund: {
    tool: { name: 'refund', revert: true },
    plan: {
      summary: 'Refund 30.00 USD to Chen',
      effects: [
        { op: 'create', target: 'refund', detail: '30.00 USD to card ••42' },
      ],
      uses: { spend: { amount: 3000, scale: 2, unit: 'USD' } },
      risk: 'low',
      undoWindow: 60,
    },
  },
  refundSmall: {
    tool: { name: 'refund', revert: true },
    plan: {
      summary: 'Refund 20.00 USD to Chen',
      effects: [
        { op: 'create', target: 'refund', detail: '20.00 USD to card ••42' },
      ],
      uses: { spend: { amount: 2000, scale: 2, unit: 'USD' } },
      risk: 'low',
      undoWindow: 60,
    },
  },
  deleteBranch: {
    tool: { name: 'delete_branch', revert: true },
    plan: {
      summary: 'Delete branch old-nav (restorable at a1b2c3d)',
      effects: [{ op: 'delete', target: 'branch/old-nav' }],
      undoWindow: 86400,
    },
  },
  deleteHigh: {
    tool: { name: 'delete_branch', revert: true },
    plan: {
      summary: 'Delete branch main',
      effects: [{ op: 'delete', target: 'branch/main' }],
      risk: 'high',
      undoWindow: 86400,
    },
  },
  customer: {
    tool: { name: 'delete_customer', revert: true },
    plan: {
      summary: 'Delete customer Chen',
      effects: [{ op: 'delete', target: 'customer/c9' }],
      risk: 'low',
      undoWindow: 60,
    },
  },
  archive: {
    tool: { name: 'archive', revert: true },
    plan: {
      summary: 'Archive project apollo',
      effects: [
        {
          op: 'update',
          target: 'project/apollo',
          field: 'archived',
          from: false,
          to: true,
        },
      ],
      risk: 'low',
      undoWindow: 60,
    },
  },
  unrated: {
    tool: { name: 'reschedule', revert: true },
    plan: {
      summary: 'Move standup',
      effects: [{ op: 'update', target: 'event/e1' }],
      undoWindow: 60,
    },
  },
};
const input = { who: 'Chen', n: 2 };
const noApply = ({ apply: _a, ...p }) => p;
const hashed = async (key) => {
  const f = plans[key];
  const [hp] = await P.hashPlans(f.tool, input, [
    { ...f.plan, apply: () => null },
  ]);

  return { ...hp, plan: noApply(hp.plan) };
};

// ---- plan hash (§1) ----
const hash = [];

for (const key of ['move', 'email', 'refund', 'unrated']) {
  const hp = await hashed(key);

  hash.push({
    name: key,
    tool: plans[key].tool,
    input,
    plan: plans[key].plan,
    risk: hp.risk,
    undoable: hp.undoable,
    planHash: hp.planHash,
  });
}

let floatError = null;

try {
  P.planPreimage('refund', { amount: 1.5 }, plans.refund.plan, 'low');
} catch (e) {
  floatError = e.message;
}

must('non-integer input', floatError !== null, true);
hash.push({
  name: 'a non-integer input fails closed',
  tool: plans.refund.tool,
  input: { amount: 1.5 },
  plan: plans.refund.plan,
  error: true,
});
must(
  'unrated plan resolves to medium',
  hash.find((h) => h.name === 'unrated').risk,
  'medium',
);

// ---- decide (§2, §5) ----
const policyGrant = await P.issueGrant({
  principal,
  to: server.public,
  iat: now - 100,
  nonce: 'pol1',
  caveats: [
    { can: ['reschedule', 'delete_*', 'refund', 'send_email'] },
    { risk: 'medium' },
    { each: { of: 'spend', max: 2500, scale: 2, unit: 'USD' } },
    { total: { of: 'emails', max: 3 } },
    { exp: now + 3600 },
  ],
});
const blockId = await P.sha256(P.decodeGrant(policyGrant)[0].s);
const strangerGrant = await P.issueGrant({
  principal: other,
  to: server.public,
  iat: now,
  nonce: 'pol2',
  caveats: [{ can: ['*'] }],
});
const base = {
  grant: policyGrant,
  principal: principal.public,
  server: server.public,
  deny: ['delete_customer'],
  outOfBand: 'high',
};
const decideCases = [
  [
    'an undoable plan the policy allows runs',
    ['move'],
    {},
    {},
    { kind: 'run', planHash: 'move', reserve: [] },
  ],
  [
    'a denied tool is refused first',
    ['customer'],
    {},
    {},
    { kind: 'denied', why: 'your policy never allows delete_customer' },
  ],
  [
    'high risk goes out of band',
    ['deleteHigh'],
    {},
    {},
    {
      kind: 'out-of-band',
      why: 'risk is high, which needs approval outside the chat',
    },
  ],
  [
    'a lower outOfBand catches medium',
    ['unrated'],
    { outOfBand: 'medium' },
    {},
    {
      kind: 'out-of-band',
      why: 'risk is medium, which needs approval outside the chat',
    },
  ],
  [
    'an irreversible plan always asks',
    ['email'],
    {},
    {},
    { kind: 'ask', why: "send_email can't be undone" },
  ],
  [
    'no signed policy asks',
    ['move'],
    { grant: null },
    {},
    { kind: 'ask', why: 'no signed policy lets reschedule run without asking' },
  ],
  [
    'a policy signed by someone else asks',
    ['move'],
    { grant: strangerGrant },
    {},
    { kind: 'ask' },
  ],
  [
    'a tool outside can asks',
    ['archive'],
    {},
    {},
    { kind: 'ask', why: 'does not cover archive' },
  ],
  [
    'over an each limit asks',
    ['refund'],
    {},
    {},
    { kind: 'ask', why: 'spend over the per-commit limit of 25.00 USD' },
  ],
  [
    'within an each limit runs',
    ['refundSmall'],
    {},
    {},
    { kind: 'run', planHash: 'refundSmall', reserve: [] },
  ],
  [
    'a total with room runs and reserves',
    ['emailUndoable'],
    {},
    { emails: { amount: 2 } },
    {
      kind: 'run',
      planHash: 'emailUndoable',
      reserve: [
        {
          key: { block: blockId, of: 'emails' },
          amount: '1000000000000000000',
          max: '3000000000000000000',
        },
      ],
    },
  ],
  [
    'a full total asks',
    ['emailUndoable'],
    {},
    { emails: { amount: 3 } },
    { kind: 'ask', why: 'emails would pass the total limit of 3' },
  ],
  [
    'an expired policy asks',
    ['move'],
    {},
    {},
    { kind: 'ask', why: 'grant has expired' },
    now + 3600,
  ],
  [
    'denied beats out of band',
    ['customer'],
    { outOfBand: 'low' },
    {},
    { kind: 'denied', why: 'your policy never allows delete_customer' },
  ],
  [
    'out of band beats not undoable',
    ['email'],
    { outOfBand: 'low' },
    {},
    {
      kind: 'out-of-band',
      why: 'risk is low, which needs approval outside the chat',
    },
  ],
  [
    'only plans[0] is judged',
    ['email', 'move'],
    {},
    {},
    { kind: 'ask', why: "send_email can't be undone" },
  ],
  ['no plans', [], {}, {}, { kind: 'nothing' }],
];
const decideOut = [];

for (const [name, keys, policyChange, used, want, at = now] of decideCases) {
  const hps = await Promise.all(keys.map(hashed));
  const policy = { ...base, ...policyChange };
  const d = await P.decide(
    hps,
    policy,
    (k) => (k.block === blockId && used[k.of] ? P.exact(used[k.of]) : 0n),
    at,
  );
  const got = {
    kind: d.kind,
    ...(d.why === undefined ? {} : { why: d.why }),
    ...(d.kind === 'run'
      ? {
          planHash: keys.find((_k, i) => hps[i].planHash === d.plan.planHash),
          reserve: d.reserve.map((r) => ({
            key: r.key,
            amount: String(r.amount),
            max: String(r.max),
          })),
        }
      : {}),
  };
  const shown =
    want.why === undefined && got.why !== undefined
      ? { ...got, why: undefined }
      : got;

  must(name, JSON.parse(JSON.stringify(shown)), want);
  decideOut.push({
    name,
    plans: hps.map((hp) => ({
      tool: hp.tool,
      plan: hp.plan,
      planHash: hp.planHash,
      risk: hp.risk,
      undoable: hp.undoable,
    })),
    policy,
    used,
    now: at,
    expect: {
      ...got,
      ...(d.kind === 'run' ? { planHash: d.plan.planHash } : {}),
    },
  });
}

// ---- phrases (§3) ----
const phrases = [
  ['  Approve ', 'approve', true],
  [' old-nav﻿\t', 'old-nav', true],
  ['old-nav​', 'old-nav', false],
  ['café', 'café', true],
  ['STRASSE', 'straße', false],
  ['OLD-NAV', 'old-nav', true],
  ['old nav', 'old-nav', false],
  [' approve', 'approve', false],
  ['', 'approve', false],
].map(([typed, phrase, match]) => {
  must(
    `phrase ${JSON.stringify(typed)}`,
    P.phraseMatches(typed, phrase),
    match,
  );

  return { typed, phrase, match };
});

// ---- the form (§3) ----
const phraseFor = (hp) =>
  hp.tool === 'delete_branch' ? 'old-nav' : P.DEFAULT_PHRASE;
const forms = [];

for (const [name, keys, why, policyChange] of [
  ['one plan', ['refund'], 'spend over the per-commit limit of 25.00 USD', {}],
  [
    'a high plan is held back',
    ['deleteBranch', 'deleteHigh'],
    "delete_branch can't be undone",
    {},
  ],
  [
    'two plans offered',
    ['refund', 'refundSmall'],
    'spend over the per-commit limit of 25.00 USD',
    {},
  ],
]) {
  const hps = await Promise.all(keys.map(hashed));
  const policy = { ...base, ...policyChange };
  const f = P.buildForm(hps, why, policy, phraseFor);

  forms.push({
    name,
    plans: hps.map((hp) => ({
      tool: hp.tool,
      plan: hp.plan,
      planHash: hp.planHash,
      risk: hp.risk,
      undoable: hp.undoable,
    })),
    why,
    policy: { outOfBand: policy.outOfBand, deny: policy.deny },
    phrases: Object.fromEntries(hps.map((hp) => [hp.planHash, phraseFor(hp)])),
    expect: f,
  });
}

must('held back', forms[1].expect.offered.length, 1);

// ---- state (§4) ----
const inputHash = await P.inputHashOf(input);
const good = {
  v: 1,
  tool: 'refund',
  inputHash,
  sub: '',
  plans: ['H1'],
  round: 1,
  nonce: 'n_x',
  exp: now + 600,
};
const expect = { tool: 'refund', inputHash, sub: '', now };
const states = [
  ['a good state', good, expect, true],
  ['another tool', good, { ...expect, tool: 'delete_branch' }, false],
  ['other input', good, { ...expect, inputHash: 'x' }, false],
  ['another principal', good, { ...expect, sub: 'client-2' }, false],
  ['expired', good, { ...expect, now: now + 600 }, false],
  ['missing nonce', { ...good, nonce: undefined }, expect, false],
  ['wrong version', { ...good, v: 2 }, expect, false],
  ['not an object', 'x', expect, false],
].map(([name, state, exp, valid]) => {
  must(name, P.checkState(state, exp) !== null, valid);

  return { name, state: JSON.parse(JSON.stringify(state)), expect: exp, valid };
});

must('input hash', inputHash, await P.sha256(P.canonical(input)));

// ---- judging the answer (§5) ----
const judge = [];

for (const [
  name,
  offeredKeys,
  recomputedKeys,
  round,
  answer,
  policyChange,
  want,
] of [
  [
    'the right phrase runs',
    ['refund'],
    ['refund'],
    1,
    { action: 'accept', content: { confirm: ' APPROVE ' } },
    {},
    { kind: 'run', plan: 'refund' },
  ],
  [
    'decline',
    ['refund'],
    ['refund'],
    1,
    { action: 'decline' },
    {},
    { kind: 'not-approved' },
  ],
  [
    'cancel',
    ['refund'],
    ['refund'],
    1,
    { action: 'cancel' },
    {},
    { kind: 'not-approved' },
  ],
  [
    'a bare accept',
    ['refund'],
    ['refund'],
    1,
    { action: 'accept' },
    {},
    { kind: 'ask-again', why: 'type "approve" exactly to approve', round: 2 },
  ],
  [
    'a wrong phrase asks again',
    ['deleteBranch'],
    ['deleteBranch'],
    1,
    { action: 'accept', content: { confirm: 'approve' } },
    {},
    { kind: 'ask-again', why: 'type "old-nav" exactly to approve', round: 2 },
  ],
  [
    'a third wrong phrase refuses',
    ['deleteBranch'],
    ['deleteBranch'],
    3,
    { action: 'accept', content: { confirm: 'yes' } },
    {},
    { kind: 'refuse', why: 'not approved after 3 tries' },
  ],
  [
    'a plan that was not offered',
    ['refund'],
    ['refund', 'refundSmall'],
    1,
    { action: 'accept', content: { plan: 'refundSmall', confirm: 'approve' } },
    {},
    { kind: 'refuse', why: 'that plan was not offered' },
  ],
  [
    'choosing among two',
    ['refund', 'refundSmall'],
    ['refund', 'refundSmall'],
    1,
    { action: 'accept', content: { plan: 'refundSmall', confirm: 'approve' } },
    {},
    { kind: 'run', plan: 'refundSmall' },
  ],
  [
    'two offered and no choice',
    ['refund', 'refundSmall'],
    ['refund', 'refundSmall'],
    1,
    { action: 'accept', content: { confirm: 'approve' } },
    {},
    { kind: 'refuse', why: 'that plan was not offered' },
  ],
  [
    'the plans changed',
    ['refund'],
    ['refundSmall'],
    1,
    { action: 'accept', content: { confirm: 'approve' } },
    {},
    { kind: 'ask-again', why: 'the plans changed; choose again', round: 2 },
  ],
  [
    'the plans changed on the last round',
    ['refund'],
    ['refundSmall'],
    3,
    { action: 'accept', content: { confirm: 'approve' } },
    {},
    { kind: 'refuse', why: 'not approved after 3 tries' },
  ],
  [
    'a tool denied since',
    ['refund'],
    ['refund'],
    1,
    { action: 'accept', content: { confirm: 'approve' } },
    { deny: ['refund'] },
    { kind: 'denied', why: 'your policy never allows refund' },
  ],
  [
    'a chosen plan now out of band',
    ['refund'],
    ['refund'],
    1,
    { action: 'accept', content: { confirm: 'approve' } },
    { outOfBand: 'low' },
    { kind: 'out-of-band', plan: 'refund' },
  ],
]) {
  const offered = await Promise.all(offeredKeys.map(hashed));
  const recomputed = await Promise.all(recomputedKeys.map(hashed));
  const byKey = Object.fromEntries(
    recomputedKeys.map((k, i) => [k, recomputed[i].planHash]),
  );
  const state = { ...good, plans: offered.map((hp) => hp.planHash), round };
  const ans = answer.content?.plan
    ? {
        ...answer,
        content: {
          ...answer.content,
          plan:
            byKey[answer.content.plan] ??
            (await hashed(answer.content.plan)).planHash,
        },
      }
    : answer;
  const policy = { ...base, ...policyChange };
  const v = P.judgeAnswer(state, ans, { recomputed, policy, phraseFor });
  const got = {
    ...v,
    ...(v.plan
      ? { plan: recomputedKeys.find((k) => byKey[k] === v.plan.planHash) }
      : {}),
  };

  must(name, got, want);
  judge.push({
    name,
    state,
    answer: ans,
    recomputed: recomputed.map((hp) => ({
      tool: hp.tool,
      plan: hp.plan,
      planHash: hp.planHash,
      risk: hp.risk,
      undoable: hp.undoable,
    })),
    policy: { outOfBand: policy.outOfBand, deny: policy.deny },
    phrases: Object.fromEntries(
      recomputed.map((hp) => [hp.planHash, phraseFor(hp)]),
    ),
    expect: { ...v, ...(v.plan ? { plan: v.plan.planHash } : {}) },
  });
}

// ---- the unsigned policy file (§2) ----
const tightening = [
  ['defaults', {}, { deny: [], outOfBand: 'high', warnings: [] }],
  [
    'deny and outOfBand',
    { deny: ['delete_customer'], outOfBand: 'medium' },
    { deny: ['delete_customer'], outOfBand: 'medium', warnings: [] },
  ],
  [
    'unknown fields are ignored',
    { deny: ['x'], can: ['*'] },
    {
      deny: ['x'],
      outOfBand: 'high',
      warnings: ['ignored "can": unknown field'],
    },
  ],
  [
    'a bad outOfBand is ignored',
    { outOfBand: 'never' },
    {
      deny: [],
      outOfBand: 'high',
      warnings: ['ignored "outOfBand": bad value'],
    },
  ],
  [
    'a bad deny is ignored',
    { deny: 'x' },
    { deny: [], outOfBand: 'high', warnings: ['ignored "deny": bad value'] },
  ],
  [
    'not an object',
    ['x'],
    {
      deny: [],
      outOfBand: 'high',
      warnings: ['the policy file is not a JSON object; ignored'],
    },
  ],
].map(([name, file, want]) => {
  must(name, P.readTightening(file), want);

  return { name, file, expect: want };
});

// ---- consent codes (§6) ----
const refundHp = await hashed('refund');
const consentCode = P.jobConsentCode({
  server: server.public,
  principal: principal.public,
  input,
  hp: refundHp,
  phrase: 'approve',
  now,
});
const decoded = P.decodeConsentCode(consentCode);

must(
  'consent code hash',
  await P.planHashOf(decoded.detail.job),
  refundHp.planHash,
);

// ---- FileStore layout (§8) ----
const dir = mkdtempSync(join(tmpdir(), 'yea-store-'));
const store = new FileStore(dir);
const key = { block: blockId, of: 'emails' };

await store.consumeOnce('n_1', now + 600);
must('consumed twice', await store.consumeOnce('n_1', now + 600), false);
await store.settle(await store.reserve(key, 5n, 10n));
must('over max', await store.reserve(key, 6n, 10n), null);
await store.putConsent(refundHp.planHash, 'pg1.example');
must('claim', await store.claimUndo('r_AAAAAAAAAAAA'), true);
await store.markUndone('r_AAAAAAAAAAAA');
must('claim after done', await store.claimUndo('r_AAAAAAAAAAAA'), false);

const files = {};
const walk = (d) => {
  for (const name of readdirSync(d)) {
    const p = join(d, name);

    if (statSync(p).isDirectory()) {
      walk(p);
    } else {
      files[relative(dir, p)] = readFileSync(p, 'utf8');
    }
  }
};

walk(dir);
rmSync(dir, { recursive: true });

export const approval = {
  seeds: { principal: seed(1), server: seed(5), stranger: seed(6) },
  keys: { principal: principal.public, server: server.public },
  policyBlockId: blockId,
  now,
  hash,
  decide: decideOut,
  phrases,
  forms,
  states,
  judge,
  tightening,
  consentCode: {
    server: server.public,
    principal: principal.public,
    input,
    plan: {
      tool: refundHp.tool,
      plan: refundHp.plan,
      planHash: refundHp.planHash,
      risk: refundHp.risk,
      undoable: refundHp.undoable,
    },
    phrase: 'approve',
    now,
    code: consentCode,
  },
  fileStore: {
    ops: [
      'consumeOnce("n_1", now + 600)',
      'reserve({block: policyBlockId, of: "emails"}, 5, 10), then settle it',
      'putConsent(<refund plan hash>, "pg1.example")',
      'claimUndo("r_AAAAAAAAAAAA"), then markUndone',
    ],
    files,
  },
};
