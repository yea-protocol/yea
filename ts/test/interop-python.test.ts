// TS client ↔ Python service (python/examples/serve.py). Skipped when uv or python/ is absent.
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as P from '../src/index.js';
import { connect } from '../src/node.js';

const pyDir = fileURLToPath(new URL('../../python', import.meta.url));
const hasUv = spawnSync('uv', ['--version']).status === 0;
const ready =
  hasUv &&
  existsSync(`${pyDir}/examples/serve.py`) &&
  !process.env.SKIP_INTEROP;

/**
 * Wait for serve.py's "up" line on stderr and return the `host:port` of its
 * TCP and HTTP servers, as bound. The service binds port 0, so parallel runs
 * never reach each other's process.
 */
function boundAddresses(proc: ChildProcess): Promise<[string, string]> {
  return new Promise((resolve, reject) => {
    let log = '';
    const fail = (why: string) =>
      reject(new Error(`python service ${why}:\n${log}`));
    const timer = setTimeout(() => fail('did not start'), 25_000);

    proc.stderr?.setEncoding('utf8');
    proc.stderr?.on('data', (chunk: string) => {
      log += chunk;

      const m = /yea:\/\/(\S+) http:\/\/(\S+)\/yea/.exec(log);

      if (m) {
        clearTimeout(timer);
        resolve([m[1], m[2]]);
      }
    });
    proc.on('exit', (code) => fail(`exited (${code})`));
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
});
