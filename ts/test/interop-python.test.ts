// TS client ↔ Python service (python/examples/serve.py). Skipped when uv or python/ is absent.
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as P from '../src/index.js';
import { fmtTime } from '../src/lens.js';
import { connect } from '../src/node.js';

const pyDir = fileURLToPath(new URL('../../python', import.meta.url));
const hasUv = spawnSync('uv', ['--version']).status === 0;
const ready =
  hasUv &&
  existsSync(`${pyDir}/examples/serve.py`) &&
  !process.env.SKIP_INTEROP;

/** serve.py's start-up line on stderr: the addresses it bound. */
const UP = /python example up · calendar yea:\/\/(\S+) http:\/\/(\S+)\/yea/;
/** tests/interop_shop.py's start-up line on stderr: the address it bound. */
const SHOP_UP = /python interop shop up · yea:\/\/(\S+)/;

/**
 * Wait for a Python service's "up" line (`up`, serve.py's by default) and return
 * the `host:port` of each server it names, as bound. The services bind port 0,
 * so parallel runs never reach each other's process.
 */
function boundAddresses(proc: ChildProcess, up = UP): Promise<string[]> {
  return new Promise((resolve, reject) => {
    let log = '';
    const fail = (why: string) => {
      clearTimeout(timer);
      reject(new Error(`python service ${why}:\n${log}`));
    };
    const timer = setTimeout(() => fail('did not start'), 25_000);

    proc.stderr?.setEncoding('utf8');
    proc.stderr?.on('data', (chunk: string) => {
      log += chunk;

      const m = up.exec(log);

      if (m) {
        clearTimeout(timer);
        resolve(m.slice(1));
      }
    });
    proc.on('error', (e) => fail(`could not start (${e.message})`));
    // 'close', not 'exit': by then stderr is drained, so the log is complete.
    proc.on('close', (code) => fail(`exited (${code})`));
  });
}

describe.skipIf(!ready)('interop: TS client → Python service', async () => {
  const principal = await P.keyPair(),
    agent = await P.keyPair();
  const urls: string[] = [];
  let proc: ChildProcess;

  beforeAll(async () => {
    proc = spawn('uv', ['run', 'python', 'examples/serve.py'], {
      cwd: pyDir,
      env: {
        ...process.env,
        YEA_TRUST: principal.public,
        HOST: '127.0.0.1',
        YEA_PORT: '0',
        YEA_HTTP_PORT: '0',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    const [tcp, http] = await boundAddresses(proc);

    urls.push(`yea://${tcp}`, `http://${http}/yea`);
  }, 30_000);
  afterAll(() => proc?.kill());

  for (const [i, transport] of ['yea', 'http'].entries()) {
    it(`full flow over ${transport}`, async () => {
      const url = urls[i];
      const grant = await P.issueGrant({
        principal,
        to: agent.public,
        caveats: [{ svc: ['calendar.example'] }],
      });
      const c = await connect(url, { key: agent.seed, grants: [grant] });
      const b = await c.hello();

      expect(b.kind).toBe('BRIEF');
      expect(b.lens).toContain('intent calendar.reschedule(');

      const q = await c.intent('calendar.reschedule', { event: 'Ana' });

      if (q.kind !== 'CLARIFY') {
        throw new Error(q.lens);
      }

      const p = await c.intent('calendar.reschedule', {
        event: 'Ana',
        ...q.options[0].params,
        day: '2031-03-04',
      });

      if (p.kind !== 'PROPOSALS') {
        throw new Error(p.lens);
      }

      expect(p.proposals[0].hash).toBe(await P.proposalHash(p.proposals[0]));

      const r = await c.commit(p.proposals[0]);

      if (r.kind !== 'RECEIPT') {
        throw new Error(r.lens);
      }

      const again = await c.commit(p.proposals[0]);

      expect(again.kind === 'RECEIPT' && again.replay).toBe(true);
      expect((await c.undo(r.receipt.id)).kind).toBe('RECEIPT');

      const auto = await c.intent(
        'calendar.reschedule',
        { event: 'e2', day: '2031-03-05' },
        { auto: true },
      );

      expect(auto.kind).toBe('RECEIPT');

      const bad = await c.ask('calendar.agnda');

      expect(bad.kind === 'ERROR' && bad.code).toBe('unknown_capability');
      c.close();
    });
  }

  // #405: the Python service reads a TS grant's periodic total as TS does: one anchored at its
  // block's nbf, with an exp, authorizes; one without an nbf fails closed on every verb.
  it('a periodic total authorizes with its one nbf and an exp, and fails closed without the nbf', async () => {
    const midnight = Math.floor(Date.now() / 86_400_000) * 86_400;
    const weekly = (anchor: P.Caveat[]) =>
      P.issueGrant({
        principal,
        to: agent.public,
        caveats: [
          { svc: ['calendar.example'] },
          {
            total: {
              of: 'spend',
              max: 50000,
              scale: 2,
              unit: 'USD',
              every: 604_800,
            },
          },
          ...anchor,
          { exp: midnight + 30 * 86_400 },
        ],
      });
    const c = await connect(urls[0], {
      key: agent.seed,
      grants: [await weekly([{ nbf: midnight }])],
    });
    const p = await c.intent('calendar.reschedule', {
      event: 'e4',
      day: '2031-03-07',
    });

    if (p.kind !== 'PROPOSALS') {
      throw new Error(p.lens);
    }

    expect((await c.commit(p.proposals[0])).kind).toBe('RECEIPT');
    c.close();

    const unanchored = await connect(urls[0], {
      key: agent.seed,
      grants: [await weekly([])],
    });
    const q = await unanchored.intent('calendar.reschedule', {
      event: 'e5',
      day: '2031-03-08',
    });

    if (q.kind !== 'PROPOSALS') {
      throw new Error(q.lens);
    }

    const r = await unanchored.commit(q.proposals[0]);

    expect(r.kind === 'ERROR' && [r.code, r.message], r.lens).toEqual([
      'forbidden',
      expect.stringContaining('a total with every needs exactly one nbf'),
    ]);
    unanchored.close();
  });

  // #287: a grant that doesn't authorize the INTENT leaves it with no principal.
  it('a COMMIT-only grant never auto-commits, and a plain COMMIT needs consent', async () => {
    const grant = await P.issueGrant({
      principal,
      to: agent.public,
      caveats: [{ svc: ['calendar.example'] }, { verbs: ['COMMIT'] }],
    });
    const c = await connect(urls[0], { key: agent.seed, grants: [grant] });
    const agenda = async () => {
      const a = await c.ask('calendar.agenda');

      return a.kind === 'ANSWER' ? a.data : a.lens;
    };
    const before = await agenda();
    const p = await c.intent(
      'calendar.reschedule',
      { event: 'e3', day: '2031-03-06' },
      { auto: true },
    );

    if (p.kind !== 'PROPOSALS') {
      throw new Error(p.lens);
    }

    const r = await c.commit(p.proposals[0]);

    expect(r.kind === 'ERROR' && [r.code, r.consent?.principal]).toEqual([
      'consent_required',
      principal.public,
    ]);
    expect(await agenda()).toEqual(before);
    c.close();
  });
});

// #405: a TS grant's weekly total counts in the Python service's ledger, as it does in TS. The
// calendar reports no `uses`, so this shop (python/tests/interop_shop.py) reports `spend`.
describe.skipIf(!ready)(
  'interop: a TS periodic total in a Python shop',
  async () => {
    const principal = await P.keyPair(),
      agent = await P.keyPair();
    let url = '';
    let proc: ChildProcess;

    beforeAll(async () => {
      proc = spawn('uv', ['run', 'python', 'tests/interop_shop.py'], {
        cwd: pyDir,
        env: { ...process.env, YEA_TRUST: principal.public, HOST: '127.0.0.1' },
        stdio: ['ignore', 'ignore', 'pipe'],
      });

      const [tcp] = await boundAddresses(proc, SHOP_UP);

      url = `yea://${tcp}`;
    }, 30_000);
    afterAll(() => proc?.kill());

    it('the first order fills the week, and the next asks and says when the week starts again', async () => {
      const week = 604_800;
      const midnight = Math.floor(Date.now() / 86_400_000) * 86_400;
      const grant = await P.issueGrant({
        principal,
        to: agent.public,
        caveats: [
          { svc: ['shop.example'] },
          {
            total: {
              of: 'spend',
              max: 1500,
              scale: 2,
              unit: 'USD',
              every: week,
            },
          },
          { nbf: midnight },
          { exp: midnight + 30 * 86_400 },
        ],
      });
      const c = await connect(url, { key: agent.seed, grants: [grant] });
      const order = async (sku: string) => {
        const p = await c.intent('shop.order', { sku });

        if (p.kind !== 'PROPOSALS') {
          throw new Error(p.lens);
        }

        return c.commit(p.proposals[0]);
      };
      const first = await order('m001');

      expect(first.kind, first.lens).toBe('RECEIPT');

      const next = await order('m002');

      expect(
        next.kind === 'ERROR' && [next.code, next.message],
        next.lens,
      ).toEqual([
        'consent_required',
        expect.stringContaining(
          `15.00 USD every 7d (starts again ${fmtTime(midnight + week)})`,
        ),
      ]);
      c.close();
    });
  },
);
