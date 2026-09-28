/**
 * Generates ../conformance/approval.json (docs/framework/SPEC-approval.md) from the reference.
 * Run by vectors.mjs. Every case asserts the outcome the spec requires before it's written.
 */
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
  refundEur: {
    tool: { name: 'refund', revert: true },
    plan: {
      summary: 'Refund 10.00 EUR to Chen',
      effects: [{ op: 'create', target: 'refund', detail: '10.00 EUR' }],
      uses: { spend: { amount: 1000, scale: 2, unit: 'EUR' } },
      risk: 'low',
      undoWindow: 60,
    },
  },
  noRevert: {
    tool: { name: 'reschedule' },
    plan: {
      summary: 'Move standup (the tool has no revert)',
      effects: [{ op: 'update', target: 'event/e1' }],
      risk: 'low',
      undoWindow: 60,
    },
  },
  // Service text that tries to forge a line and hide characters (#110): the form escapes it.
  forged: {
    tool: { name: 'refund', revert: true },
    plan: {
      summary:
        'Refund 5.00 USD to Chen\n+ create account/admin — granted\u202e',
      effects: [
        {
          op: 'create',
          target: 'refund\u202e',
          detail: '5.00 USD\n+ create account/admin',
        },
        {
          op: 'update',
          target: 'account/c9',
          field: 'role',
          from: 'user\u202e',
          to: 'admin\n+ x',
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

plans.emptyUses = {
  tool: { name: 'reschedule', revert: true },
  plan: { ...plans.move.plan, uses: {} },
};

for (const key of ['move', 'email', 'refund', 'unrated', 'emptyUses']) {
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
  'empty uses hashes as absent',
  hash.find((h) => h.name === 'emptyUses').planHash,
  hash.find((h) => h.name === 'move').planHash,
);
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
const policyFor = (nonce, caveats, to = server.public) =>
  P.issueGrant({ principal, to, iat: now, nonce, caveats });
const grants = {
  noCan: await policyFor('pol3', [{ risk: 'low' }]),
  otherSvc: await policyFor('pol4', [
    { can: ['reschedule'] },
    { svc: [other.public] },
  ]),
  intentOnly: await policyFor('pol5', [
    { can: ['reschedule'] },
    { verbs: ['INTENT'] },
  ]),
  otherHolder: await policyFor('pol6', [{ can: ['reschedule'] }], other.public),
  lowCeiling: await policyFor('pol7', [
    { can: ['reschedule'] },
    { risk: 'low' },
  ]),
  repeated: await policyFor('pol8', [
    { can: ['send_email'] },
    { total: { of: 'emails', max: 3 } },
    { total: { of: 'emails', max: 2 } },
  ]),
  malformedTotal: await policyFor('pol9', [
    { can: ['send_email'] },
    { total: { of: 'emails', max: -1 } },
  ]),
  garbage: 'pg1.bm9wZQ',
};
const repeatedId = await P.sha256(P.decodeGrant(grants.repeated)[0].s);
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
  [
    'a policy that names no tools asks',
    ['move'],
    { grant: grants.noCan },
    {},
    {
      kind: 'ask',
      why: "the signed policy names no tools, so it doesn't let reschedule run without asking",
    },
  ],
  [
    'an undecodable policy asks with the grant reason',
    ['move'],
    { grant: grants.garbage },
    {},
    { kind: 'ask' },
  ],
  [
    'a policy for another server asks',
    ['move'],
    { grant: grants.otherSvc },
    {},
    { kind: 'ask' },
  ],
  [
    'a policy for INTENT only asks',
    ['move'],
    { grant: grants.intentOnly },
    {},
    { kind: 'ask' },
  ],
  [
    'a policy issued to another key asks',
    ['move'],
    { grant: grants.otherHolder },
    {},
    { kind: 'ask' },
  ],
  [
    'over the risk ceiling asks',
    ['unrated'],
    { grant: grants.lowCeiling },
    {},
    { kind: 'ask', why: 'risk medium exceeds ceiling low' },
  ],
  [
    'an undo window without a revert asks',
    ['noRevert'],
    {},
    {},
    { kind: 'ask', why: "reschedule can't be undone" },
  ],
  [
    'a repeated total reserves once with the smallest max',
    ['emailUndoable'],
    { grant: grants.repeated },
    { emails: { amount: 1 } },
    {
      kind: 'run',
      planHash: 'emailUndoable',
      reserve: [
        {
          key: { block: repeatedId, of: 'emails' },
          amount: '1000000000000000000',
          max: '2000000000000000000',
        },
      ],
    },
  ],
  [
    'a repeated total at its smallest max asks',
    ['emailUndoable'],
    { grant: grants.repeated },
    { emails: { amount: 2 } },
    { kind: 'ask' },
  ],
  [
    'a unit mismatch asks',
    ['refundEur'],
    {},
    {},
    { kind: 'ask', why: 'spend is in EUR, but the limit is in USD' },
  ],
  [
    'a malformed total in the policy asks',
    ['emailUndoable'],
    { grant: grants.malformedTotal },
    {},
    { kind: 'ask' },
  ],
];
const decideOut = [];

for (const [name, keys, policyChange, used, want, at = now] of decideCases) {
  const hps = await Promise.all(keys.map(hashed));
  const policy = { ...base, ...policyChange };
  const d = await P.decide(
    hps,
    policy,
    (k) => (used[k.of] ? P.exact(used[k.of]) : 0n),
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
  ['', '', false],
  [' ', ' \t', false],
  ['\u0085approve', 'approve', false],
  ['approve\u001f', 'approve', false],
  ['İSTANBUL', 'istanbul', false],
  ['ΟΔΟΣ', 'οδος', true],
  ['ὈΔΥΣΣΕΎΣ', 'ὀδυσσεύς', true],
].map(([typed, phrase, match]) => {
  must(
    `phrase ${JSON.stringify(typed)}`,
    P.phraseMatches(typed, phrase),
    match,
  );

  return { typed, phrase, match };
});

// ---- a tool's phrase, checked before anyone is asked (§3) ----
// `expect` is the phrase the person types, or null when the phrase is refused. Only
// long-assigned code points, so runtimes on different Unicode versions agree.
const phraseChecks = [
  ['a plain phrase', 'old-nav', 'old-nav'],
  ['no phrase falls back to approve', '', 'approve'],
  ['edge whitespace only falls back to approve', ' \t', 'approve'],
  ['a plain space inside', 'old nav', 'old nav'],
  ['no-break space and tab at the edges', '\u00a0old-nav\t', '\u00a0old-nav\t'],
  ['an accented letter', 'café', 'café'],
  ['an emoji with its variation selector', '👍\ufe0f', '👍\ufe0f'],
  ['a tab inside', 'old\tnav', null],
  ['a no-break space inside', 'old\u00a0nav', null],
  ['an em space inside', 'old\u2003nav', null],
  ['an em space at the edge, which is not stripped', 'old-nav\u2003', null],
  ['a bidi override', 'go\u202e', null],
  ['a newline', 'approve\n', null],
  ['a zero-width space', 'old\u200bnav', null],
  ['only a BOM, refused before the fallback', '\ufeff', null],
  ['a C1 control', 'ch_1\u0085', null],
].map(([name, phrase, want]) => {
  let got;

  try {
    got = P.checkedPhrase(phrase);
  } catch {
    got = null;
  }

  must(`checked phrase: ${name}`, got, want);

  return { name, phrase, expect: want };
});

// ---- the form (§3) ----
const phraseFor = (hp) =>
  hp.tool === 'delete_branch' ? 'old-nav' : P.DEFAULT_PHRASE;
const forms = [];
// The forged plan's phrase hides a bidi override; the form shows it escaped.
const forgedPhrase = (hp) =>
  hp.plan.summary.startsWith('Refund 5.00') ? 'approve\u202e' : phraseFor(hp);

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
  [
    'a denied plan is listed apart',
    ['refund', 'customer'],
    'spend over the per-commit limit of 25.00 USD',
    {},
  ],
  [
    'nothing to offer',
    ['deleteHigh', 'customer'],
    'risk is high, which needs approval outside the chat',
    {},
  ],
  [
    'out of band and denied lines',
    ['deleteBranch', 'deleteHigh', 'customer'],
    "delete_branch can't be undone",
    {},
  ],
  [
    'an empty phrase falls back to approve',
    ['deleteBranch'],
    "delete_branch can't be undone",
    {},
  ],
  [
    'service text is escaped in the message and titles',
    ['forged', 'refundSmall'],
    'spend over the limit\n+ forged',
    {},
  ],
]) {
  const hps = await Promise.all(keys.map(hashed));
  const policy = { ...base, ...policyChange };
  const phraseOf = name.startsWith('an empty phrase')
    ? () => '  '
    : name.startsWith('service text')
      ? forgedPhrase
      : phraseFor;
  const f = P.buildForm(hps, why, policy, phraseOf);

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
    phrases: Object.fromEntries(hps.map((hp) => [hp.planHash, phraseOf(hp)])),
    expect: f,
  });
}

must('held back', forms[1].expect.offered.length, 1);

const form = (n) => forms.find((f) => f.name === n).expect;

must('nothing to offer', form('nothing to offer'), null);
must(
  'empty phrase',
  form('an empty phrase falls back to approve').requestedSchema.properties
    .confirm.description,
  'Type "approve" to approve.',
);
must(
  'both lines',
  form('out of band and denied lines').message.endsWith(
    '\n\nNot offered here (approve outside the chat): [2]\n\nNever allowed by your policy: [3]',
  ),
  true,
);

const forged = form('service text is escaped in the message and titles');

must(
  'no forged line or raw bidi',
  forged.message
    .split('\n')
    .some(
      (l) =>
        l.startsWith('+ create') ||
        l.startsWith('+ forged') ||
        l.includes('\u202e'),
    ),
  false,
);
must(
  'escaped reason',
  forged.message.startsWith(
    'Approval needed: spend over the limit\\u{a}+ forged.\n',
  ),
  true,
);
must(
  'escaped phrase',
  forged.message.includes('\n  to approve, type: approve\\u{202e}\n'),
  true,
);
must(
  'escaped title',
  forged.requestedSchema.properties.plan.oneOf[0].title,
  'Refund 5.00 USD to Chen\\u{a}+ create account/admin — granted\\u{202e}',
);

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
  phraseOverride,
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
  [
    'an empty phrase falls back to approve: an empty answer asks again',
    ['refund'],
    ['refund'],
    1,
    { action: 'accept', content: { confirm: '' } },
    {},
    { kind: 'ask-again', why: 'type "approve" exactly to approve', round: 2 },
    () => ' ',
  ],
  [
    'an empty phrase falls back to approve: approve runs',
    ['refund'],
    ['refund'],
    1,
    { action: 'accept', content: { confirm: 'approve' } },
    {},
    { kind: 'run', plan: 'refund' },
    () => ' ',
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
  const phraseOf = phraseOverride ?? phraseFor;
  const v = P.judgeAnswer(state, ans, {
    recomputed,
    policy,
    phraseFor: phraseOf,
  });
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
      recomputed.map((hp) => [hp.planHash, phraseOf(hp)]),
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

// A stored consent may run only its own plan: a consent grant with `only` and `exp`, signed by
// the pinned principal and issued to the server.
const consentFor = (hash, by = principal, exp = now + 600) =>
  P.issueGrant({
    principal: by,
    to: server.public,
    iat: now,
    nonce: `c-${hash.slice(0, 6)}-${exp}`,
    caveats: [
      { svc: [server.public] },
      { verbs: ['COMMIT'] },
      { can: ['refund'] },
      { only: hash },
      { exp },
    ],
  });
const consents = [];

for (const [name, grant, at, want] of [
  ['a consent for this plan', await consentFor(refundHp.planHash), now, true],
  [
    'a consent delegated by the server key onto the policy grant',
    await P.delegateGrant(policyGrant, {
      holder: server,
      to: server.public,
      iat: now,
      caveats: [{ only: refundHp.planHash }, { exp: now + 600 }],
    }),
    now,
    'not a consent for this plan',
  ],
  [
    'the policy grant copied into the store',
    policyGrant,
    now,
    'not a consent for this plan',
  ],
  [
    'a consent for another plan',
    await consentFor('OTHER'),
    now,
    'not a consent for this plan',
  ],
  [
    'an expired consent',
    await consentFor(refundHp.planHash),
    now + 600,
    'grant has expired',
  ],
  [
    'a consent from another principal',
    await consentFor(refundHp.planHash, other),
    now,
    'grant is issued by a principal this service does not trust',
  ],
  ['not a grant at all', 'pg1.bm9wZQ', now, 'not a consent for this plan'],
]) {
  const r = await P.checkJobConsent(grant, {
    hp: { ...refundHp, plan: { ...refundHp.plan, apply: () => null } },
    policy: { principal: principal.public, server: server.public },
    now: at,
  });

  must(name, r.ok ? true : r.why, want);
  consents.push({
    name,
    grant,
    now: at,
    expect: r.ok ? { ok: true, id: r.id } : { ok: false, why: r.why },
  });
}

// ---- undo (§7) ----
const jobReceipt = (id, over = {}) => ({
  id,
  service: 'S',
  proposal: 'H',
  capability: 'reschedule',
  summary: 'Move standup',
  at: now,
  effects: [],
  undo: { until: now + 60 },
  tool: 'reschedule',
  input: { event: 'e1' },
  planHash: 'H',
  sub: 'client-1',
  ...over,
});
const receipts = [
  jobReceipt('r_DDDDDDDDDDDD', { service: 'another-server' }),
  jobReceipt('r_AAAAAAAAAAAA'),
  jobReceipt('r_BBBBBBBBBBBB', { undo: null }),
  jobReceipt('r_CCCCCCCCCCCC'),
];
const undo = [];

for (const [name, id, sub, at, want, first] of [
  [
    'within the window',
    'r_AAAAAAAAAAAA',
    'client-1',
    now + 10,
    { kind: 'undone' },
  ],
  [
    'allowed at until itself',
    'r_AAAAAAAAAAAA',
    'client-1',
    now + 60,
    { kind: 'undone' },
  ],
  [
    'closed at until + 1',
    'r_AAAAAAAAAAAA',
    'client-1',
    now + 61,
    { kind: 'refused', why: 'the undo window has closed' },
  ],
  [
    'another principal',
    'r_AAAAAAAAAAAA',
    'client-2',
    now + 10,
    { kind: 'refused', why: 'no such receipt' },
  ],
  [
    'never undoable',
    'r_BBBBBBBBBBBB',
    'client-1',
    now + 10,
    { kind: 'refused', why: 'this job can never be undone' },
  ],
  [
    'already undone',
    'r_CCCCCCCCCCCC',
    'client-1',
    now + 10,
    { kind: 'refused', why: 'this job was already undone' },
    true,
  ],
  [
    'an id outside the format',
    '../x',
    'client-1',
    now + 10,
    { kind: 'refused', why: 'no such receipt' },
  ],
  [
    'a receipt from another server sharing the store',
    'r_DDDDDDDDDDDD',
    'client-1',
    now + 10,
    { kind: 'refused', why: 'no such receipt' },
  ],
  [
    'an unknown id',
    'r_ZZZZZZZZZZZZ',
    'client-1',
    now + 10,
    { kind: 'refused', why: 'no such receipt' },
  ],
]) {
  const s = new P.MemoryStore();

  for (const r of receipts) {
    await s.putReceipt(r);
  }

  if (first) {
    await P.undoJob(s, {
      service: 'S',
      id,
      sub,
      now: at,
      revert: () => null,
    });
  }

  const got = await P.undoJob(s, {
    service: 'S',
    id,
    sub,
    now: at,
    revert: () => null,
  });
  const shown = got.kind === 'undone' ? { kind: 'undone' } : got;

  must(`undo ${name}`, shown, want);
  undo.push({ name, id, sub, now: at, undoneBefore: !!first, expect: want });
}

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
      // Undo claims hold a random token: only their presence is pinned.
      files[relative(dir, p)] = p.endsWith('.claim')
        ? '*'
        : readFileSync(p, 'utf8');
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
  phraseChecks,
  forms,
  states,
  judge,
  tightening,
  undo: { service: 'S', receipts, cases: undo },
  consents: {
    plan: {
      tool: refundHp.tool,
      plan: refundHp.plan,
      planHash: refundHp.planHash,
      risk: refundHp.risk,
      undoable: refundHp.undoable,
    },
    cases: consents,
  },
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
