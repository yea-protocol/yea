/**
 * Generates ../conformance/pending.json (docs/framework/SPEC-approval.md §6, Short ids): the
 * pending file every consent code issuer writes, for every writer to replay. Run by vectors.mjs.
 * Ids are random, so the ops name them by label; each op asserts what the spec requires before
 * it's written.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jobConsentCode } from '../dist/ask.js';
import { PENDING_ID, PendingCodes } from '../dist/file-store.js';
import * as P from '../dist/index.js';

const seed = (n) => P.b64u(new Uint8Array(32).fill(n));
const now = 1790000000;
const principal = await P.keyPair(seed(1));
const server = await P.keyPair(seed(5));
const agent = await P.keyPair(seed(7));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const must = (name, got, want) => {
  if (!same(got, want)) {
    throw new Error(
      `pending case ${name}: expected ${JSON.stringify(want)} got ${JSON.stringify(got)}`,
    );
  }
};

/** A framework server's code for one plan, issued at `at` (it expires 10 minutes later). */
async function jobCode(summary, at) {
  const [hp] = await P.hashPlans({ name: 'delete_file' }, { path: 'a.txt' }, [
    { summary, effects: [], risk: 'medium', apply: () => null },
  ]);

  return jobConsentCode({
    server: server.public,
    principal: principal.public,
    input: { path: 'a.txt' },
    hp,
    phrase: 'approve',
    now: at,
  });
}

/** The bridge's code for a service's proposal, naming the agent it's for. */
async function bridgeCode() {
  const p = {
    id: 'p_1',
    capability: 'shop.order',
    summary: 'Order 1 × m001',
    effects: [],
    risk: 'low',
    undo: null,
    expires: now + 900,
  };
  const proposal = { ...p, hash: await P.proposalHash(p) };

  return P.consentCode(
    {
      proposal: proposal.id,
      hash: proposal.hash,
      service: 'shop.example',
      capability: proposal.capability,
      principal: principal.public,
      summary: proposal.summary,
      expires: proposal.expires,
    },
    proposal,
    { agent: agent.public },
  );
}

const codes = {
  old: await jobCode('Delete a.txt', now - 700),
  plan: await jobCode('Delete a.txt', now),
  again: await jobCode('Delete a.txt', now + 60),
  other: await jobCode('Delete a.txt for good', now),
  bridge: await bridgeCode(),
};
const pairOf = (label) => {
  const c = P.decodeConsentCode(codes[label]);

  return { service: c.service, proposal: c.proposal };
};

// Each op runs on one directory, in order. `put` names the id it returns by `as`: a label seen
// before must get the same id back. `files` is the directory after the op, by label.
const ops = [
  { op: 'put', code: 'old', now: now - 700, as: 'x', files: { x: 'old' } },
  // The old code expired at now - 100, but it's the same plan: its file is rewritten, same id.
  { op: 'put', code: 'plan', now, as: 'x', files: { x: 'plan' } },
  { op: 'put', code: 'other', now, as: 'y', files: { x: 'plan', y: 'other' } },
  {
    op: 'put',
    code: 'bridge',
    now,
    as: 'z',
    files: { x: 'plan', y: 'other', z: 'bridge' },
  },
  {
    op: 'put',
    code: 'again',
    now,
    as: 'x',
    files: { x: 'again', y: 'other', z: 'bridge' },
  },
  { op: 'drop', ...pairOf('other'), files: { x: 'again', z: 'bridge' } },
  // Writing removes what has expired: `again` at now + 660, `bridge` at now + 900.
  {
    op: 'put',
    code: 'other',
    now: now + 700,
    as: 'w',
    files: { z: 'bridge', w: 'other' },
  },
];

const WRITTEN_ID = /^[a-z2-7]{10}$/;
const dir = mkdtempSync(join(tmpdir(), 'yea-pending-'));
const store = new PendingCodes(dir);
const ids = {};

for (const [i, o] of ops.entries()) {
  if (o.op === 'put') {
    const id = store.put(codes[o.code], o.now);
    const fresh = !(o.as in ids);

    must(`op ${i} id`, ids[o.as] ?? id, id);
    must(`op ${i} id is new`, fresh && Object.values(ids).includes(id), false);
    must(`op ${i} id format`, WRITTEN_ID.test(id), true);
    ids[o.as] = id;
  } else {
    store.drop(o.service, o.proposal);
  }

  const byId = Object.fromEntries(
    Object.entries(ids).map(([label, id]) => [id, label]),
  );
  const files = readdirSync(dir)
    .map((f) => [
      byId[f],
      Object.keys(codes).find(
        (k) => `${codes[k]}\n` === readFileSync(join(dir, f), 'utf8'),
      ),
    ])
    .sort();

  must(`op ${i} files`, files, Object.entries(o.files).sort());
}

rmSync(dir, { recursive: true });

export const pending = {
  // Where each issuer writes, and what `yea approve <id>` accepts.
  dirs: { server: '<store>/pending', bridge: '<home>/pending' },
  writtenId: WRITTEN_ID.source,
  readId: PENDING_ID.source,
  maxBytes: 65536,
  // The file for a code is exactly this: the code, then a newline.
  file: { code: codes.plan, text: `${codes.plan}\n` },
  // Never in any file: the bridge's code names this agent, whose seed is this.
  agentSeed: agent.seed,
  codes,
  ops,
};
