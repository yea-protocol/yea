/** Generates ../conformance/*.json from the reference implementation. Deterministic. */
import { writeFileSync } from 'node:fs';
import * as P from '../dist/index.js';

const out = (name, v) =>
  writeFileSync(
    new URL(`../../conformance/${name}.json`, import.meta.url),
    `${JSON.stringify(v, null, 2)}\n`,
  );
const seed = (n) => P.b64u(new Uint8Array(32).fill(n));

/** `{canonical}`, or `{error: true}` when canonical JSON refuses the value. */
function canonicalOrError(input) {
  try {
    return { canonical: P.canonical(input) };
  } catch {
    return { error: true };
  }
}

// canonical
const canon = [
  ['scalars', [null, true, false, 0, -1, 9007199254740991, '']],
  ['key order', { b: 1, a: 2, A: 3, _: 4, aa: 5, 'a b': 6 }],
  ['nested', { z: { y: [3, { x: null }], a: [] }, m: {} }],
  [
    'escapes',
    {
      s: 'quote " back \\ nl \n tab \t cr \r bs \b ff \f nul \u0000 us \u001f del \u007f',
    },
  ],
  ['unicode', { s: 'café — 東京 🎉  ' }],
  ['slash', { s: 'a/b<c>&' }],
  ['surrogate pair', { s: '\ud83c\udf89' }],
  // A lone surrogate has no UTF-8 encoding, so canonical JSON refuses it (SPEC §10).
  ['lone high surrogate', { s: 'a\ud800b' }],
  ['lone low surrogate', { s: '\udfff' }],
  ['surrogates in the wrong order', { s: '\udf89\ud83c' }],
  ['lone surrogate in a key', { '\ud800': 1 }],
  ['lone surrogate in an array', ['ok', '\udc00']],
].map(([name, input]) => ({ name, input, ...canonicalOrError(input) }));

out('canonical', canon);

// keys
const keys = [];

for (const n of [0, 1, 7, 42, 255]) {
  keys.push({ seed: seed(n), public: (await P.keyPair(seed(n))).public });
}

out('keys', keys);

// hash
const baseP = {
  id: 'p_1',
  capability: 'calendar.reschedule',
  summary: 'Move "1:1 with Ana" to Thu 15:00',
  effects: [
    {
      op: 'update',
      target: 'event/e42',
      field: 'start',
      from: '2026-09-22T14:00:00Z',
      to: '2026-09-24T15:00:00Z',
    },
    { op: 'send', target: 'ana@example.com', detail: 'update notification' },
  ],
  risk: 'low',
  undo: { window: 3600 },
  expires: 1790000600,
};
const hash = [
  { name: 'basic', proposal: baseP },
  {
    name: 'with uses and data (data excluded)',
    proposal: {
      ...baseP,
      id: 'p_2',
      uses: {
        spend: { amount: 1250, scale: 2, unit: 'USD' },
        emails: { amount: 1 },
      },
      risk: 'medium',
      undo: null,
      data: { note: 'not hashed', n: 1.5 },
    },
  },
  { name: 'hash field ignored', proposal: { ...baseP, hash: 'whatever' } },
];

for (const h of hash) {
  h.hash = await P.proposalHash(h.proposal);
}

out('hash', hash);

// proof
const proofs = [];

for (const [aud, verb, target, ts] of [
  ['cal.example.com', 'COMMIT', 'abc', 1790000000],
  ['shop.example', 'ASK', 'shop.search', 1],
]) {
  const p = await P.makeProof(seed(2), { aud, verb, target }, ts);

  proofs.push({ seed: seed(2), aud, verb, target, ts, key: p.key, sig: p.sig });
}

out('proof', proofs);

// grants
const principal = await P.keyPair(seed(1)),
  agent = await P.keyPair(seed(2)),
  sub = await P.keyPair(seed(3)),
  mallory = await P.keyPair(seed(4));
const now = 1790000000;
const root = await P.issueGrant({
  principal,
  to: agent.public,
  iat: now - 100,
  nonce: 'n1',
  caveats: [
    { svc: ['shop.example'] },
    { can: ['shop.*'] },
    { exp: now + 3600 },
    { total: { of: 'spend', max: 5000, scale: 2, unit: 'USD' } },
    { each: { of: 'spend', max: 3000, scale: 2, unit: 'USD' } },
    { risk: 'medium' },
  ],
});
const narrowed = await P.delegateGrant(root, {
  holder: agent,
  to: sub.public,
  iat: now - 50,
  caveats: [{ can: ['shop.search'] }, { verbs: ['ASK', 'INTENT'] }],
});
const consent = await P.issueGrant({
  principal,
  to: agent.public,
  iat: now,
  nonce: 'n2',
  caveats: [
    { svc: ['shop.example'] },
    { verbs: ['COMMIT'] },
    { can: ['shop.order'] },
    { only: 'HASH_OK' },
    { exp: now + 600 },
  ],
});
const badRisk = await P.issueGrant({
  principal,
  to: agent.public,
  iat: now,
  nonce: 'n5',
  caveats: [{ risk: 'extreme' }],
});
const badSvc = await P.issueGrant({
  principal,
  to: agent.public,
  iat: now,
  nonce: 'n6',
  caveats: [{ svc: 'shop.example.evil' }],
});
const badExp = await P.issueGrant({
  principal,
  to: agent.public,
  iat: now,
  nonce: 'n7',
  caveats: [{ exp: 'tomorrow' }],
});
const protoRisk = await P.issueGrant({
  principal,
  to: agent.public,
  iat: now,
  nonce: 'n8',
  caveats: [{ risk: 'toString' }],
});
const nullCav = await P.issueGrant({
  principal,
  to: agent.public,
  iat: now,
  nonce: 'n9',
  caveats: [null],
});
const unknownCav = await P.issueGrant({
  principal,
  to: agent.public,
  iat: now,
  nonce: 'n3',
  caveats: [{ region: 'eu' }],
});
const forged = await P.issueGrant({
  principal: mallory,
  to: agent.public,
  iat: now,
  nonce: 'n4',
  caveats: [],
});
// Limits in other forms: a whole-dollar limit (scale 0), a count, and a name only a
// prototype lookup would find.
const counts = await P.issueGrant({
  principal,
  to: agent.public,
  iat: now,
  nonce: 'n10',
  caveats: [
    { each: { of: 'spend', max: 30, unit: 'USD' } },
    { total: { of: 'emails', max: 3 } },
    { total: { of: 'tenths', max: 3, scale: 1 } },
    { each: { of: 'constructor', max: 0 } },
    { each: { of: 'big', max: 9007199254740991, scale: 18 } },
  ],
});
const countsId = await P.sha256(P.decodeGrant(counts)[0].s);
const badLimit = (nonce, caveat) =>
  P.issueGrant({
    principal,
    to: agent.public,
    iat: now,
    nonce,
    caveats: [caveat],
  });
const scaleTooBig = await badLimit('n11', {
  each: { of: 'spend', max: 1, scale: 19, unit: 'USD' },
});
const maxNotInt = await badLimit('n12', { total: { of: 'spend', max: '1' } });
const oldShape = await badLimit('n13', {
  each: { of: 'spend', max: 1, currency: 'USD' },
});
const oldCaveat = await badLimit('n14', { per: { max: 1, currency: 'USD' } });
const badName = await badLimit('n15', { each: { of: 'Spend', max: 1 } });
const extraAmount = await badLimit('n16', {
  each: { of: 'spend', max: 100, amount: 7 },
});
const rootBlocks = P.decodeGrant(root);
const tampered = P.encodeGrant([
  { ...rootBlocks[0], p: { ...rootBlocks[0].p, caveats: [] } },
]);
const rootSpendId = await P.sha256(rootBlocks[0].s);
const T = [principal.public];
const commit = (cents, risk = 'low', hash = 'HASH_X') => ({
  hash,
  ...(cents === null
    ? {}
    : { uses: { spend: { amount: cents, scale: 2, unit: 'USD' } } }),
  risk,
});
/** A COMMIT of a proposal that reports `uses` (for the counts grant). */
const using = (uses) => ({ hash: 'HASH_U', uses, risk: 'low' });
const c = (proposal, extra = {}) => ({
  service: 'shop.example',
  verb: 'COMMIT',
  capability: 'shop.order',
  now,
  proposal,
  ...extra,
});
const cases = [
  [
    'root: ask ok',
    root,
    agent.public,
    { service: 'shop.example', verb: 'ASK', capability: 'shop.search', now },
    { ok: true },
  ],
  [
    'root: commit within limits',
    root,
    agent.public,
    {
      service: 'shop.example',
      verb: 'COMMIT',
      capability: 'shop.order',
      now,
      proposal: commit(2000),
    },
    { ok: true },
  ],
  [
    'root: wrong service',
    root,
    agent.public,
    { service: 'evil.example', verb: 'ASK', capability: 'shop.search', now },
    { ok: false, code: 'forbidden' },
  ],
  [
    'root: capability not covered',
    root,
    agent.public,
    { service: 'shop.example', verb: 'ASK', capability: 'bank.transfer', now },
    { ok: false, code: 'forbidden' },
  ],
  [
    'root: expired',
    root,
    agent.public,
    {
      service: 'shop.example',
      verb: 'ASK',
      capability: 'shop.search',
      now: now + 3600,
    },
    { ok: false, code: 'forbidden' },
  ],
  [
    'root: per-commit limit needs consent',
    root,
    agent.public,
    {
      service: 'shop.example',
      verb: 'COMMIT',
      capability: 'shop.order',
      now,
      proposal: commit(3500),
    },
    { ok: false, code: 'consent_required' },
  ],
  [
    'root: cumulative spend needs consent',
    root,
    agent.public,
    {
      service: 'shop.example',
      verb: 'COMMIT',
      capability: 'shop.order',
      now,
      proposal: commit(2000),
      used: { [rootSpendId]: { spend: { amount: 4000, scale: 2 } } },
    },
    { ok: false, code: 'consent_required' },
  ],
  [
    'root: risk ceiling needs consent',
    root,
    agent.public,
    {
      service: 'shop.example',
      verb: 'COMMIT',
      capability: 'shop.order',
      now,
      proposal: commit(100, 'high'),
    },
    { ok: false, code: 'consent_required' },
  ],
  [
    'root: other unit (never converted)',
    root,
    agent.public,
    c(using({ spend: { amount: 1, scale: 2, unit: 'EUR' } })),
    { ok: false, code: 'consent_required' },
  ],
  [
    'root: unit on the limit only is a mismatch',
    root,
    agent.public,
    c(using({ spend: { amount: 1, scale: 2 } })),
    { ok: false, code: 'consent_required' },
  ],
  [
    'counts: unit on the proposal only is a mismatch',
    counts,
    agent.public,
    c(using({ emails: { amount: 1, unit: 'msg' } })),
    { ok: false, code: 'consent_required' },
  ],
  [
    'root: a proposal that uses nothing passes limits',
    root,
    agent.public,
    c(commit(null)),
    { ok: true },
  ],
  [
    'root: an unlimited measure passes',
    root,
    agent.public,
    c(using({ emails: { amount: 1000 } })),
    { ok: true },
  ],
  ['root: empty uses passes', root, agent.public, c(using({})), { ok: true }],
  [
    'counts: 30 USD at scale 0 allows 3000 cents',
    counts,
    agent.public,
    c(using({ spend: { amount: 3000, scale: 2, unit: 'USD' } })),
    { ok: true },
  ],
  [
    'counts: 30 USD at scale 0 refuses 3001 cents',
    counts,
    agent.public,
    c(using({ spend: { amount: 3001, scale: 2, unit: 'USD' } })),
    { ok: false, code: 'consent_required' },
  ],
  [
    'counts: finer scale compares exactly (30.001 > 30)',
    counts,
    agent.public,
    c(using({ spend: { amount: 30001, scale: 3, unit: 'USD' } })),
    { ok: false, code: 'consent_required' },
  ],
  [
    'counts: total within the limit',
    counts,
    agent.public,
    c(using({ emails: { amount: 1 } }), {
      used: { [countsId]: { emails: { amount: 2 } } },
    }),
    { ok: true },
  ],
  [
    'counts: total over the limit',
    counts,
    agent.public,
    c(using({ emails: { amount: 1 } }), {
      used: { [countsId]: { emails: { amount: 3 } } },
    }),
    { ok: false, code: 'consent_required' },
  ],
  [
    'counts: exact decimals, 0.1 + 0.2 fits 0.3',
    counts,
    agent.public,
    c(using({ tenths: { amount: 2, scale: 1 } }), {
      used: { [countsId]: { tenths: { amount: 1, scale: 1 } } },
    }),
    { ok: true },
  ],
  [
    'counts: prototype names are not measures the proposal uses',
    counts,
    agent.public,
    c(using({ emails: { amount: 1 } })),
    { ok: true },
  ],
  [
    'counts: largest values compare exactly',
    counts,
    agent.public,
    c(using({ big: { amount: 9007199254740991, scale: 18 } })),
    { ok: true },
  ],
  [
    'counts: 10 is over 0.009007199254740991',
    counts,
    agent.public,
    c(using({ big: { amount: 10 } })),
    { ok: false, code: 'consent_required' },
  ],
  [
    'malformed uses: negative amount fails closed',
    root,
    agent.public,
    c(using({ spend: { amount: -1, scale: 2, unit: 'USD' } })),
    { ok: false, code: 'forbidden' },
  ],
  [
    'malformed uses: scale over 18 fails closed',
    root,
    agent.public,
    c(using({ spend: { amount: 1, scale: 19, unit: 'USD' } })),
    { ok: false, code: 'forbidden' },
  ],
  [
    'malformed uses: bad measure name fails closed',
    root,
    agent.public,
    c(using({ 'Bad Name': { amount: 1 } })),
    { ok: false, code: 'forbidden' },
  ],
  [
    'malformed uses: amount past 2^53-1 fails closed',
    root,
    agent.public,
    c(using({ spend: { amount: 9007199254740992, unit: 'USD' } })),
    { ok: false, code: 'forbidden' },
  ],
  [
    'malformed uses: extra key fails closed',
    root,
    agent.public,
    c(using({ spend: { amount: 1, scale: 2, unit: 'USD', currency: 'USD' } })),
    { ok: false, code: 'forbidden' },
  ],
  [
    'malformed uses: null fails closed',
    root,
    agent.public,
    c(using(null)),
    { ok: false, code: 'forbidden' },
  ],
  [
    'malformed uses fails closed even when the limit is on another measure',
    root,
    agent.public,
    c(using({ emails: { amount: -1 } })),
    { ok: false, code: 'forbidden' },
  ],
  [
    'an unknown risk on the proposal fails closed',
    root,
    agent.public,
    c(commit(100, 'critical')),
    { ok: false, code: 'forbidden' },
  ],
  [
    'malformed limit: an extra amount key',
    extraAmount,
    agent.public,
    c(commit(1)),
    { ok: false, code: 'forbidden' },
  ],
  [
    'malformed limit: scale over 18',
    scaleTooBig,
    agent.public,
    c(commit(1)),
    { ok: false, code: 'forbidden' },
  ],
  [
    'malformed limit: max not an integer',
    maxNotInt,
    agent.public,
    c(commit(1)),
    { ok: false, code: 'forbidden' },
  ],
  [
    'malformed limit: the old currency shape',
    oldShape,
    agent.public,
    c(commit(1)),
    { ok: false, code: 'forbidden' },
  ],
  [
    'malformed limit: bad measure name',
    badName,
    agent.public,
    c(commit(1)),
    { ok: false, code: 'forbidden' },
  ],
  [
    'the removed per caveat is unknown',
    oldCaveat,
    agent.public,
    c(commit(1)),
    { ok: false, code: 'forbidden' },
  ],
  [
    'root: proof key is not holder',
    root,
    sub.public,
    { service: 'shop.example', verb: 'ASK', capability: 'shop.search', now },
    { ok: false, code: 'unauthorized' },
  ],
  [
    'root: untrusted principal',
    root,
    agent.public,
    {
      service: 'shop.example',
      verb: 'ASK',
      capability: 'shop.search',
      now,
      trusted: [mallory.public],
    },
    { ok: false, code: 'unauthorized' },
  ],
  [
    'delegated: sub-agent ask ok',
    narrowed,
    sub.public,
    { service: 'shop.example', verb: 'ASK', capability: 'shop.search', now },
    { ok: true },
  ],
  [
    'delegated: attenuated capability',
    narrowed,
    sub.public,
    { service: 'shop.example', verb: 'ASK', capability: 'shop.order', now },
    { ok: false, code: 'forbidden' },
  ],
  [
    'delegated: attenuated verbs',
    narrowed,
    sub.public,
    {
      service: 'shop.example',
      verb: 'COMMIT',
      capability: 'shop.search',
      now,
      proposal: commit(10),
    },
    { ok: false, code: 'forbidden' },
  ],
  [
    'delegated: parent holder cannot use it',
    narrowed,
    agent.public,
    { service: 'shop.example', verb: 'ASK', capability: 'shop.search', now },
    { ok: false, code: 'unauthorized' },
  ],
  [
    'consent: matching hash ok',
    consent,
    agent.public,
    {
      service: 'shop.example',
      verb: 'COMMIT',
      capability: 'shop.order',
      now,
      proposal: commit(999999, 'high', 'HASH_OK'),
    },
    { ok: true },
  ],
  [
    'consent: cannot UNDO anything',
    consent,
    agent.public,
    { service: 'shop.example', verb: 'UNDO', capability: 'shop.order', now },
    { ok: false, code: 'forbidden' },
  ],
  [
    'consent: cannot be used at another service',
    consent,
    agent.public,
    {
      service: 'calendar.example',
      verb: 'COMMIT',
      capability: 'shop.order',
      now,
      proposal: commit(1, 'low', 'HASH_OK'),
    },
    { ok: false, code: 'forbidden' },
  ],
  [
    'consent: other proposal',
    consent,
    agent.public,
    {
      service: 'shop.example',
      verb: 'COMMIT',
      capability: 'shop.order',
      now,
      proposal: commit(1, 'low', 'HASH_OTHER'),
    },
    { ok: false, code: 'forbidden' },
  ],
  [
    'malformed risk level fails closed',
    badRisk,
    agent.public,
    {
      service: 'shop.example',
      verb: 'COMMIT',
      capability: 'shop.order',
      now,
      proposal: commit(1),
    },
    { ok: false, code: 'forbidden' },
  ],
  [
    'svc must be a list (no substring match)',
    badSvc,
    agent.public,
    { service: 'shop.example', verb: 'ASK', capability: 'shop.search', now },
    { ok: false, code: 'forbidden' },
  ],
  [
    'exp must be an integer',
    badExp,
    agent.public,
    { service: 'shop.example', verb: 'ASK', capability: 'shop.search', now },
    { ok: false, code: 'forbidden' },
  ],
  [
    'risk level must be an own key (no prototype names)',
    protoRisk,
    agent.public,
    {
      service: 'shop.example',
      verb: 'COMMIT',
      capability: 'shop.order',
      now,
      proposal: commit(1, 'high'),
    },
    { ok: false, code: 'forbidden' },
  ],
  [
    'null caveat fails closed',
    nullCav,
    agent.public,
    { service: 'shop.example', verb: 'ASK', capability: 'shop.search', now },
    { ok: false, code: 'forbidden' },
  ],
  [
    'unknown caveat fails closed',
    unknownCav,
    agent.public,
    { service: 'shop.example', verb: 'ASK', capability: 'shop.search', now },
    { ok: false, code: 'forbidden' },
  ],
  [
    'forged issuer',
    forged,
    agent.public,
    { service: 'shop.example', verb: 'ASK', capability: 'shop.search', now },
    { ok: false, code: 'unauthorized' },
  ],
  [
    'tampered caveats',
    tampered,
    agent.public,
    { service: 'shop.example', verb: 'ASK', capability: 'shop.search', now },
    { ok: false, code: 'unauthorized' },
  ],
  [
    'garbage token',
    'pg1.bm9wZQ',
    agent.public,
    { service: 'shop.example', verb: 'ASK', capability: 'shop.search', now },
    { ok: false, code: 'unauthorized' },
  ],
];
const gcases = [];

for (const [name, token, proofKey, c, expect] of cases) {
  const { trusted = T, used, ...ctx } = c;
  const got = await P.checkGrant(token, {
    ...ctx,
    trusted,
    proofKey,
    used: (id, of) => P.exact(used?.[id]?.[of] ?? { amount: 0 }),
  });
  const actual = got.ok ? { ok: true } : { ok: false, code: got.code };

  if (JSON.stringify(actual) !== JSON.stringify(expect)) {
    throw new Error(
      `grant case ${name}: expected ${JSON.stringify(expect)} got ${JSON.stringify(got)}`,
    );
  }

  gcases.push({
    name,
    token,
    trusted,
    proofKey,
    ctx: { ...ctx, ...(used ? { used } : {}) },
    expect,
  });
}

// A protocol consent code (a tooling format, not wire bytes): the request, the proposal as
// detail (without `data`), and the agent key the consent should be issued to.
const codeDetail = { ...hash[1].proposal, hash: hash[1].hash };
const codeRequest = {
  proposal: codeDetail.id,
  hash: codeDetail.hash,
  service: 'calendar.example',
  capability: codeDetail.capability,
  principal: principal.public,
  summary: codeDetail.summary,
  expires: codeDetail.expires,
};

out('grants', {
  seeds: {
    principal: seed(1),
    agent: seed(2),
    subagent: seed(3),
    mallory: seed(4),
  },
  rootTotalBlockId: rootSpendId,
  countsTotalBlockId: countsId,
  cases: gcases,
  consentCode: {
    consent: codeRequest,
    detail: codeDetail,
    agent: agent.public,
    code: P.consentCode(codeRequest, codeDetail, { agent: agent.public }),
  },
});

// lens
const values = [
  [
    'scalars',
    {
      n: null,
      t: true,
      f: false,
      i: 42,
      x: 1.5,
      neg: -3,
      big: 1e21,
      small: 1e-7,
    },
  ],
  [
    'strings',
    {
      bare: 'hello world',
      iso: '2026-09-24T15:00:00Z',
      email: 'ana@example.com',
      empty: '',
      sp: ' lead',
      comma: 'a, b',
      numeric: '123',
      word: 'true',
      dash: '-',
      uni: 'café',
      nl: 'two\nlines',
      q: 'say "hi"',
    },
  ],
  ['nested', { user: { name: 'Ana', tags: ['a', 'b'], prefs: {}, list: [] } }],
  [
    'table',
    {
      events: [
        { id: 'e1', title: 'Standup', start: '09:00' },
        { id: 'e2', title: '1:1, Ana', start: '14:00' },
      ],
    },
  ],
  [
    'mixed list',
    { items: [1, { a: 1, b: { c: 2 } }, [1, 2], [{ x: 1 }], 's', {}] },
  ],
  [
    'list of objects with nested',
    {
      rows: [
        { id: 1, meta: { k: 'v' } },
        { id: 2, meta: { k: 'w' } },
      ],
    },
  ],
  [
    'top array table',
    [
      { a: 1, b: 2 },
      { a: 3, b: 4 },
    ],
  ],
  ['top scalar list', [1, 'two', null]],
  ['top scalar', 'just text'],
  ['empty object', {}],
  ['odd keys', { 'has space': 1, 'k,v': 2, '': 3 }],
  // Lens quotes a lone surrogate as JSON.stringify does, though canonical JSON refuses it.
  [
    'lone surrogates',
    { lone: 'a\ud800', pair: '\ud83c\udf89', '\udfff': 'key' },
  ],
];
const lensCases = values.map(([name, input]) => ({
  name,
  type: 'value',
  input,
  lens: P.lean(input),
}));
const r = (x) => ({ yea: 1, id: 's1', re: 'c1', ...x });
const replies = [
  [
    'brief',
    r({
      kind: 'BRIEF',
      service: {
        id: 'cal.example.com',
        name: 'Example Calendar',
        summary: 'Your calendar.',
      },
      capabilities: [
        {
          name: 'calendar.find',
          kind: 'ask',
          summary: 'Search events',
          params: { 'query?': 'string', 'day?': 'date' },
        },
        {
          name: 'calendar.reschedule',
          kind: 'intent',
          summary: 'Move a meeting',
          params: {
            event: 'string — id or title',
            to: 'datetime',
            opts: { 'notify?': 'bool' },
            'items?': [{ sku: 'string', qty: 'int' }],
          },
          risk: 'low',
        },
        { name: 'calendar.ping', kind: 'ask', summary: 'Health' },
      ],
    }),
  ],
  [
    'proposals',
    r({
      kind: 'PROPOSALS',
      proposals: [
        { ...baseP, hash: 'h1' },
        {
          id: 'p_2',
          capability: 'shop.order',
          summary: 'Order 2 items',
          effects: [
            { op: 'create', target: 'order' },
            {
              op: 'create',
              target: 'charge',
              detail: '12.50 USD to card ••42',
            },
            { op: 'delete', target: 'cart/1' },
            { op: 'other', target: 'x', to: 5 },
          ],
          uses: {
            spend: { amount: 1250, scale: 2, unit: 'USD' },
            emails: { amount: 2 },
          },
          risk: 'medium',
          undo: null,
          expires: 1790000605,
          hash: 'h2',
          data: {
            eta: '2026-09-25',
            items: [
              { sku: 'a', qty: 1 },
              { sku: 'b', qty: 2 },
            ],
          },
        },
        {
          id: 'p_3',
          capability: 'shop.order',
          summary: 'Yen',
          effects: [],
          uses: { spend: { amount: 500, unit: 'JPY' } },
          risk: 'high',
          undo: { window: 90 },
          expires: 1790000000,
          hash: 'h3',
        },
        {
          id: 'p_4',
          capability: 'shop.order',
          summary: 'Tiny',
          effects: [],
          uses: {
            zero: { amount: 0, scale: 2 },
            fine: { amount: 5, scale: 18, unit: 'ETH' },
          },
          risk: 'low',
          undo: { window: 172800 },
          expires: 1790000000,
          hash: 'h4',
        },
      ],
      more: [{ handle: 'h_abc', path: 'proposals', remaining: 3, est: 210 }],
    }),
  ],
  [
    'proposals: all attributes shared',
    r({
      kind: 'PROPOSALS',
      proposals: [
        { ...baseP, hash: 'h1' },
        { ...baseP, id: 'p_9', summary: 'Move to Fri', hash: 'h9' },
      ],
    }),
  ],
  [
    'proposals: some attributes shared',
    r({
      kind: 'PROPOSALS',
      proposals: [
        {
          ...baseP,
          hash: 'h1',
          uses: { spend: { amount: 100, scale: 2, unit: 'USD' } },
        },
        {
          ...baseP,
          id: 'p_9',
          summary: 'Faster',
          uses: { spend: { amount: 900, scale: 2, unit: 'USD' } },
          risk: 'medium',
          hash: 'h9',
          data: { eta: 'noon' },
        },
      ],
    }),
  ],
  [
    'auto receipt shows effects',
    r({
      kind: 'RECEIPT',
      auto: true,
      receipt: {
        id: 'r_4',
        proposal: 'p_1',
        capability: 'calendar.reschedule',
        summary: 'Moved',
        at: 1790000100,
        effects: baseP.effects,
        undo: { until: 1790003700 },
      },
    }),
  ],
  [
    'brief without summaries',
    r({
      kind: 'BRIEF',
      service: { id: 'x', name: 'X' },
      capabilities: [{ name: 'x.a', kind: 'ask' }],
    }),
  ],
  [
    'one proposal',
    r({
      kind: 'PROPOSALS',
      proposals: [{ ...baseP, undo: { window: 45 }, hash: 'h1' }],
    }),
  ],
  [
    'clarify',
    r({
      kind: 'CLARIFY',
      question: 'Which Ana?',
      options: [
        { label: 'Ana Ruiz (design)', params: { event: 'e42' } },
        { label: 'Ana Li (sales)', params: { event: 'e77' } },
      ],
    }),
  ],
  [
    'receipt',
    r({
      kind: 'RECEIPT',
      receipt: {
        id: 'r_1',
        proposal: 'p_1',
        capability: 'calendar.reschedule',
        summary: 'Moved',
        at: 1790000100,
        effects: baseP.effects,
        undo: { until: 1790003700 },
        result: { event: 'e42' },
      },
    }),
  ],
  [
    'receipt replay irreversible',
    r({
      kind: 'RECEIPT',
      replay: true,
      receipt: {
        id: 'r_2',
        proposal: 'p_2',
        capability: 'shop.order',
        summary: 'Ordered',
        at: 1790000100,
        effects: [],
        undo: null,
      },
    }),
  ],
  [
    'undo receipt',
    r({
      kind: 'RECEIPT',
      receipt: {
        id: 'r_3',
        proposal: 'p_1',
        capability: 'calendar.reschedule',
        summary: 'Moved',
        at: 1790000200,
        effects: [
          {
            op: 'update',
            target: 'event/e42',
            field: 'start',
            from: '2026-09-24T15:00:00Z',
            to: '2026-09-22T14:00:00Z',
          },
        ],
        undo: null,
        undoes: 'r_1',
      },
    }),
  ],
  [
    'answer with more',
    r({
      kind: 'ANSWER',
      data: { events: [{ id: 'e1', t: 'a' }] },
      more: [{ handle: 'h_1', path: 'data.events', remaining: 12, est: 96 }],
    }),
  ],
  [
    'error full',
    r({
      kind: 'ERROR',
      code: 'invalid_params',
      message: '`to` must be in the future',
      fix: [
        { say: 'use next year', params: { to: '2026-09-24T15:00:00Z' } },
        { say: 'or ask the user' },
      ],
      need: [{ can: ['x.*'] }],
      retry: 3600,
    }),
  ],
  [
    'error consent',
    r({
      kind: 'ERROR',
      code: 'consent_required',
      message: 'spend over the per-commit limit of 25.00 USD',
      consent: {
        proposal: 'p_2',
        hash: 'h2',
        service: 'shop.example',
        capability: 'shop.order',
        principal: 'ed25519:x',
        summary: 'Order 2 items',
        expires: 1790000605,
      },
    }),
  ],
  [
    'proposals: uses shared when identical',
    r({
      kind: 'PROPOSALS',
      proposals: [
        { ...baseP, hash: 'h1', uses: { emails: { amount: 1 } } },
        {
          ...baseP,
          id: 'p_9',
          summary: 'Also',
          uses: { emails: { amount: 1 } },
          hash: 'h9',
        },
      ],
    }),
  ],
  [
    'proposals: uses on one proposal only',
    r({
      kind: 'PROPOSALS',
      proposals: [
        { ...baseP, hash: 'h1' },
        {
          ...baseP,
          id: 'p_9',
          summary: 'Notify too',
          uses: { emails: { amount: 3 } },
          hash: 'h9',
        },
      ],
    }),
  ],
  ['event', r({ kind: 'EVENT', message: 'charging card', progress: 0.42 })],
  ['event plain', r({ kind: 'EVENT', message: 'started' })],
  // Malformed fields and unknown kinds render a fixed way (SPEC §9.2), never an error.
  [
    'unknown kind',
    r({
      kind: 'STATUS',
      text: 'syncing',
      more: [{ handle: 'h_2', path: 'items', remaining: 3, est: 20 }],
    }),
  ],
  ['unknown kind: not a string', r({ kind: ['ANSWER'], data: 1 })],
  ['no kind', r({ text: 'hello' })],
  [
    'proposals: malformed uses',
    r({
      kind: 'PROPOSALS',
      proposals: [
        { ...baseP, uses: { Bad: { amount: 1 }, spend: { amount: 'x' } } },
      ],
    }),
  ],
  [
    'proposals: malformed times',
    r({
      kind: 'PROPOSALS',
      proposals: [
        { ...baseP, expires: 1.5, undo: { window: 'soon' } },
        { ...baseP, id: 'p_2', expires: 'tomorrow', undo: { window: 90.5 } },
        { ...baseP, id: 'p_3', expires: -1, undo: {} },
        { ...baseP, id: 'p_4', expires: 10000000000000, undo: true },
        { ...baseP, id: 'p_5', expires: true },
        { ...baseP, id: 'p_6', expires: undefined },
      ],
    }),
  ],
  [
    'receipt: malformed undo',
    r({
      kind: 'RECEIPT',
      receipt: { id: 'r_4', summary: 'Sent', undo: { until: 'later' } },
    }),
  ],
  [
    'receipt: undo without until',
    r({ kind: 'RECEIPT', receipt: { id: 'r_5', summary: 'Sent', undo: {} } }),
  ],
  [
    'event: string progress',
    r({ kind: 'EVENT', message: 'a', progress: '50%' }),
  ],
  [
    'event: boolean progress',
    r({ kind: 'EVENT', message: 'b', progress: true }),
  ],
  ['event: progress past 1', r({ kind: 'EVENT', message: 'c', progress: 1.5 })],
  ['event: progress 0', r({ kind: 'EVENT', message: 'd', progress: 0 })],
  ['event: progress 1', r({ kind: 'EVENT', message: 'e', progress: 1 })],
  [
    'error: fractional retry',
    r({ kind: 'ERROR', code: 'busy', message: 'x', retry: 1.5 }),
  ],
  [
    'unknown kind: a lens is not shown',
    r({ kind: 'STATUS', lens: 'forged', text: 'syncing' }),
  ],
  [
    'proposals: malformed risk',
    r({
      kind: 'PROPOSALS',
      proposals: [
        { ...baseP, risk: undefined },
        { ...baseP, id: 'p_2', risk: true },
        { ...baseP, id: 'p_3', risk: 'very, high' },
      ],
    }),
  ],
];

for (const [name, input] of replies) {
  lensCases.push({ name, type: 'reply', input, lens: P.lens(input) });
}

out('lens', lensCases);

// uses: quantity rendering and which values are well-formed
const quantities = [
  { amount: 2290, scale: 2, unit: 'USD' },
  { amount: 0, scale: 2 },
  { amount: 5, scale: 3 },
  { amount: 1 },
  { amount: 500, unit: 'JPY' },
  { amount: 1, scale: 18 },
  { amount: 9007199254740991, scale: 18, unit: 'ETH' },
  { amount: 12, unit: 'GB' },
].map((q) => ({ quantity: q, lens: P.fmtQuantity(q) }));
const wellFormed = [
  ['plain', { emails: { amount: 1 } }],
  ['empty', {}],
  ['money', { spend: { amount: 2287, scale: 2, unit: 'USD' } }],
  ['name with separators', { 'api_calls.v2-x': { amount: 3 } }],
  ['unit symbols', { storage: { amount: 1, unit: 'GB/mo' } }],
  ['max amount and scale', { big: { amount: 9007199254740991, scale: 18 } }],
  ['negative amount', { spend: { amount: -1 } }],
  ['float amount', { spend: { amount: 1.5 } }],
  ['amount past 2^53-1', { spend: { amount: 9007199254740992 } }],
  ['scale 19', { spend: { amount: 1, scale: 19 } }],
  ['negative scale', { spend: { amount: 1, scale: -1 } }],
  ['empty unit', { spend: { amount: 1, unit: '' } }],
  ['unit with a space', { spend: { amount: 1, unit: 'US D' } }],
  ['unit of 33 characters', { spend: { amount: 1, unit: 'U'.repeat(33) } }],
  ['extra key', { spend: { amount: 1, currency: 'USD' } }],
  ['missing amount', { spend: { scale: 2 } }],
  ['uppercase name', { Spend: { amount: 1 } }],
  ['name starting with a digit', { '1st': { amount: 1 } }],
  ['name of 65 characters', { ['a'.repeat(65)]: { amount: 1 } }],
  ['not an object', [{ amount: 1 }]],
  ['null', null],
  ['null quantity', { spend: null }],
].map(([name, uses]) => ({ name, uses, valid: P.isUses(uses) }));

out('uses', { quantities, wellFormed });

// estimate
out(
  'estimate',
  [
    '',
    'a',
    'abcd',
    'abcde',
    'café',
    '東京🎉',
    'hello world',
    'x: 12345\n  - y',
    'a\u00a0b\tc',
    'p_KEs5H7dM · 2026-09-24T15:00Z',
    '  lead\n    deep\n z',
  ].map((text) => ({ text, est: P.est(text) })),
);
out('approval', (await import('./approval-vectors.mjs')).approval);
console.log('vectors written');
