/**
 * Generates ../conformance/commit-ledger.json from the reference: the order the commit ledger
 * checks a COMMIT in (SPEC §4.4, ADR-0002). A repeat is a replay first, for its principal only;
 * then an expired proposal is refused, before its limits; then grant evaluation runs, with the
 * limits; then the reservation. Each case is a scene and a COMMIT (commit-ledger-run.mjs), with
 * what it got. Run by vectors.mjs.
 */
import * as P from '../dist/index.js';
import { CommitLedger } from '../dist/service/commit-ledger.js';
import { runCase } from './commit-ledger-run.mjs';

const scene = {
  committed: false,
  full: false,
  late: false,
  by: 'alice',
  admit: 'admits',
};

const cases = [
  ['a new commit its grant admits, on time, with room', {}],
  [
    'a repeat past expiry, whose limits now refuse it, is a replay',
    { committed: true, late: true, admit: 'consent_required' },
  ],
  ['a repeat by another principal', { committed: true, by: 'eve' }],
  [
    'an expired proposal its limits refuse',
    { late: true, admit: 'consent_required' },
  ],
  ['an expired proposal its grant forbids', { late: true, admit: 'forbidden' }],
  [
    'an expired proposal with no room under its total',
    { late: true, full: true },
  ],
  ['a proposal its limits refuse', { admit: 'consent_required' }],
  ['a proposal its grant forbids', { admit: 'forbidden' }],
  ['a proposal its grant admits, with no room under its total', { full: true }],
];

export const commitLedger = [];

for (const [name, c] of cases) {
  const input = { ...scene, ...c };

  commitLedger.push({
    name,
    ...input,
    ...(await runCase({ CommitLedger, YeaError: P.YeaError }, input)),
  });
}
