// Regression tests for the security audit findings (see docs/design.md).

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { shop } from '../../examples/shop.ts';
import { consentFrom, consentLines, consentView } from '../src/approve.js';
import * as P from '../src/index.js';
import {
  checkKeyFile,
  FileStore,
  listen,
  readPinnedKey,
  readPrivateFile,
  readServerSeed,
  serveHttp,
} from '../src/node.js';
import { printable } from '../src/text.js';

// A pass-through `openSync` that can run a hook right after the real open, to swap a key file
// between the open and the read (the private key files block below). Null leaves fs alone.
const fsHook = vi.hoisted(() => ({
  afterOpen: null as ((path: string) => void) | null,
}));

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  const openSync = (...args: Parameters<typeof real.openSync>) => {
    const fd = real.openSync(...args);

    fsHook.afterOpen?.(String(args[0]));

    return fd;
  };

  return { ...real, default: { ...real, openSync }, openSync };
});

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const closers: (() => void)[] = [];

afterAll(() => {
  for (const close of closers) {
    close();
  }
});

const principal = await P.keyPair(),
  agent = await P.keyPair(),
  other = await P.keyPair(),
  otherAgent = await P.keyPair();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function payService(opts: { slow?: number; failRevert?: boolean } = {}) {
  return P.service({
    id: 'pay',
    name: 'Pay',
    summary: 'pay',
    trust: [principal.public, other.public],
  }).intent('pay.send', {
    summary: 'send money',
    params: { to: 'string', amt: 'int', 'cur?': 'string' },
    plan: ({ params }) => ({
      summary: `pay ${params.to} ${params.amt}`,
      effects: [P.create(`payment/${params.to}`)],
      uses: {
        spend: P.quantity(params.amt, {
          scale: 2,
          unit: params.cur ?? 'USD',
        }),
      },
      apply: async () => {
        if (opts.slow) {
          await sleep(opts.slow);
        }

        return { secret: `order-for-${params.to}` };
      },
      revert: async () => {
        if (opts.failRevert) {
          throw new Error('bank down');
        }
      },
    }),
  });
}

const client = async (
  svc: P.Service,
  who: P.KeyPair,
  from: P.KeyPair,
  caveats: P.Caveat[] = [],
) =>
  new P.Client(P.local(svc), {
    key: who.seed,
    grants: [await P.issueGrant({ principal: from, to: who.public, caveats })],
  });
const intent = async (c: P.Client, params: Record<string, unknown>) => {
  const r = await c.intent('pay.send', params);

  if (r.kind !== 'PROPOSALS') {
    throw new Error(r.lens);
  }

  return r.proposals[0];
};

describe('security regressions', () => {
  it("[H1] malformed or aborted HTTP requests don't crash the bridge", async () => {
    const server = await serveHttp(payService(), { port: 0 });

    closers.push(() => server.close());

    const port = (server.address() as AddressInfo).port;
    // Send raw bytes, then hang up after a moment. The point is only that the server survives.
    const raw = (data: string) =>
      new Promise<void>((res) => {
        const s = net.connect(port, '127.0.0.1', () => s.write(data));

        s.on('error', () => {});
        setTimeout(() => {
          s.destroy();
          res();
        }, 150);
      });

    await raw('GET /yea HTTP/1.1\r\nHost: [bad\r\n\r\n');
    await raw(
      'POST /yea HTTP/1.1\r\nHost: x\r\nContent-Length: 1000\r\n\r\nhello',
    );

    const ok = await (
      await fetch(`http://127.0.0.1:${port}/.well-known/yea`)
    ).json();

    expect(ok.kind).toBe('BRIEF');

    const big = await fetch(`http://127.0.0.1:${port}/yea`, {
      method: 'POST',
      body: 'x'.repeat((1 << 20) + 10),
    });

    expect(big.status).toBe(413);
  });

  it("[H2] concurrent commits can't overshoot a spend cap", async () => {
    const svc = payService({ slow: 30 });
    const c = await client(svc, agent, principal, [
      { total: { of: 'spend', max: 100, scale: 2, unit: 'USD' } },
    ]);
    const [p1, p2] = [
      await intent(c, { to: 'a', amt: 60 }),
      await intent(c, { to: 'b', amt: 60 }),
    ];
    const [r1, r2] = await Promise.all([c.commit(p1), c.commit(p2)]);

    expect([r1.kind, r2.kind].sort()).toEqual(['ERROR', 'RECEIPT']);
    expect((r1.kind === 'ERROR' ? r1 : (r2 as P.ErrorReply)).code).toBe(
      'consent_required',
    );
  });

  // [H3] (the bridge never signs a consent that doesn't match the proposal it showed) moved with
  // the bridge to mcp/test/bridge-security.test.ts.

  it("[M4] only the agent that requested a proposal can commit it; anonymous proposals can't be committed", async () => {
    const svc = payService();
    const anon = new P.Client(P.local(svc));
    const anonProposal = await intent(anon, { to: 'attacker', amt: 40 });
    const victim = await client(svc, agent, principal);
    const r = await victim.commit(anonProposal);

    expect(r.kind === 'ERROR' && r.code).toBe('forbidden');

    const mine = await intent(victim, { to: 'shop', amt: 5 });
    const thief = await client(svc, otherAgent, principal); // same principal, different agent key

    expect((await thief.commit(mine)).kind === 'ERROR').toBe(true);
  });

  it("[M5] conflict doesn't leak the hash; another principal can't read a receipt via replay", async () => {
    const svc = payService();
    const c = await client(svc, agent, principal);
    const p = await intent(c, { to: 'a', amt: 5 });
    const conflict = await c.commit({ id: p.id, hash: 'x' });

    expect(conflict.lens).not.toContain(p.hash);
    expect((await c.commit(p)).kind).toBe('RECEIPT');

    const eve = await client(svc, otherAgent, other);
    const r = await eve.commit(p);

    expect(r.kind).toBe('ERROR');
    expect(r.lens).not.toContain('order-for-a');
  });

  it('[M6] replaying a commit returns the receipt even when its spend used up the cap', async () => {
    const c = await client(payService(), agent, principal, [
      { total: { of: 'spend', max: 100, scale: 2, unit: 'USD' } },
    ]);
    const p = await intent(c, { to: 'a', amt: 60 });

    expect((await c.commit(p)).kind).toBe('RECEIPT');

    const again = await c.commit(p);

    expect(again.kind === 'RECEIPT' && again.replay).toBe(true);
    // a *different* 60 still needs consent
    expect(
      ((await c.commit(await intent(c, { to: 'b', amt: 60 }))) as P.ErrorReply)
        .code,
    ).toBe('consent_required');
  });

  it("[M7] huge unknown names don't burn CPU on suggestions", async () => {
    const svc = payService();
    const t = Date.now();
    const r = await svc.handle({
      yea: 1,
      id: 'x',
      verb: 'ASK',
      capability: 'a'.repeat(300_000),
    });

    expect(r.kind).toBe('ERROR');
    expect(Date.now() - t).toBeLessThan(100);
  });

  it('[L8] EXPAND handles are bound to the agent that got them', async () => {
    const svc = shop({ trust: [principal.public] });
    const c = await client(svc, agent, principal);
    const a = (await c.ask('shop.search', {}, { budget: 200 })) as P.Answer;
    const h = a.more![0].handle;

    expect((await new P.Client(P.local(svc)).expand(h)).kind).toBe('ERROR');
    expect(
      (await (await client(svc, otherAgent, principal)).expand(h)).kind,
    ).toBe('ERROR');
    expect((await c.expand(h)).kind).toBe('ANSWER');
  });

  it('[L10/L15] odd caveat values fail closed instead of open or throwing', async () => {
    for (const cav of [
      { risk: 'toString' },
      null,
      { risk: 'constructor' },
    ] as unknown as P.Caveat[]) {
      const g = await P.issueGrant({
        principal,
        to: agent.public,
        caveats: [cav],
      });
      const r = await P.checkGrant(g, {
        service: 's',
        verb: 'COMMIT',
        capability: 'x',
        trusted: [principal.public],
        proofKey: agent.public,
        proposal: { hash: 'h', risk: 'high' },
      });

      expect(r.ok ? 'ok' : r.code).toBe('forbidden');
    }
  });

  it('[L11] concurrent failing UNDOs each get their own reply', async () => {
    const c = await client(payService({ failRevert: true }), agent, principal);
    const r = await c.commit(await intent(c, { to: 'a', amt: 1 }));

    if (r.kind !== 'RECEIPT') {
      throw new Error(r.lens);
    }

    const frames: string[] = [];
    const [u1, u2] = await Promise.all([
      c.undo(r.receipt.id),
      c.undo(r.receipt.id),
    ]);

    frames.push(u1.re, u2.re);
    expect(new Set(frames).size).toBe(2);
  });

  it('[L13] oversized TCP frames are rejected and the connection keeps working', async () => {
    const server = await listen(payService(), { port: 0 });

    closers.push(() => server.close());

    const s = net.connect((server.address() as AddressInfo).port, '127.0.0.1');
    let out = '';

    s.setEncoding('utf8');
    s.on('data', (d: string) => (out += d));
    await new Promise((r) => s.once('connect', r));
    s.write(
      JSON.stringify({
        yea: 1,
        id: 'big',
        verb: 'ASK',
        capability: 'x'.repeat((1 << 20) + 5),
      }) +
        '\n' +
        JSON.stringify({ yea: 1, id: 'ok', verb: 'HELLO' }) +
        '\n',
    );

    for (let i = 0; i < 100 && !out.includes('"re":"ok"'); i++) {
      await sleep(10);
    }

    s.destroy();
    expect(out).toContain('frame exceeds 1 MiB');
    expect(out).toContain('"re":"ok"');
  });

  it('[U1] a spend in another currency never passes a limit; it asks instead of converting', async () => {
    const c = await client(payService(), agent, principal, [
      { each: { of: 'spend', max: 100000, scale: 2, unit: 'USD' } },
    ]);
    const r = await c.commit(await intent(c, { to: 'a', amt: 1, cur: 'EUR' }));

    expect(r.kind === 'ERROR' && r.code).toBe('consent_required');
  });

  it('[U2] a plan with a malformed uses never becomes a proposal', async () => {
    const svc = P.service({
      id: 'bad',
      name: 'Bad',
      summary: 'bad',
      trust: [principal.public],
    }).intent('bad.do', {
      summary: 'do',
      plan: () => ({
        summary: 'do it',
        effects: [],
        uses: { spend: { amount: -1, unit: 'USD' } },
        apply: () => null,
      }),
    });
    const c = await client(svc, agent, principal);
    const r = await c.intent('bad.do', {});

    expect(r.kind === 'ERROR' && r.code).toBe('internal');
  });

  it('[U3] malformed each and total limits fail closed', async () => {
    for (const bad of [
      { each: { of: 'spend', max: 1, scale: 19, unit: 'USD' } },
      { total: { of: 'spend', max: -1 } },
      { each: { of: 'spend', max: 1, currency: 'USD' } },
      { per: { max: 1, currency: 'USD' } },
    ]) {
      const c = await client(payService(), agent, principal, [bad as P.Caveat]);
      const r = await c.commit(await intent(c, { to: 'a', amt: 1 }));

      expect(r.kind === 'ERROR' && r.code, JSON.stringify(bad)).toBe(
        'forbidden',
      );
    }
  });

  it('[U4] a block that repeats a total counts each commit once', async () => {
    const limit = { of: 'spend', max: 100, scale: 2, unit: 'USD' };
    const c = await client(payService(), agent, principal, [
      { total: limit },
      { total: limit },
    ]);

    expect((await c.commit(await intent(c, { to: 'a', amt: 60 }))).kind).toBe(
      'RECEIPT',
    );
    expect((await c.commit(await intent(c, { to: 'b', amt: 30 }))).kind).toBe(
      'RECEIPT',
    );
  });

  it('[U5] two concurrent COMMITs of one proposal run it once and count it once', async () => {
    let runs = 0;
    const svc = P.service({
      id: 'pay',
      name: 'Pay',
      summary: 'pay',
      trust: [principal.public],
    }).intent('pay.send', {
      summary: 'send money',
      params: { to: 'string', amt: 'int' },
      plan: ({ params }) => ({
        summary: `pay ${params.to}`,
        effects: [P.create(`payment/${params.to}`)],
        uses: { spend: P.quantity(params.amt, { scale: 2, unit: 'USD' }) },
        apply: async () => {
          runs++;
          await sleep(20);

          return null;
        },
      }),
    });
    const c = await client(svc, agent, principal, [
      { total: { of: 'spend', max: 100, scale: 2, unit: 'USD' } },
    ]);
    const p = await intent(c, { to: 'a', amt: 60 });
    const [r1, r2] = await Promise.all([c.commit(p), c.commit(p)]);

    expect(runs).toBe(1);
    expect([r1.kind, r2.kind]).toEqual(['RECEIPT', 'RECEIPT']);
    expect(
      [r1, r2].filter((r) => r.kind === 'RECEIPT' && r.replay),
    ).toHaveLength(1);
    // Only 60 of the 100 is used, so a 40 still fits.
    expect((await c.commit(await intent(c, { to: 'b', amt: 40 }))).kind).toBe(
      'RECEIPT',
    );
  });

  it('[U10] a plan with an unknown risk never becomes a proposal', async () => {
    const errors: unknown[] = [];
    // `undefined` leaves the field out; anything else, `null` included, is set.
    const svc = (plan: unknown, def: unknown) =>
      P.service({
        id: 'bad',
        name: 'Bad',
        summary: 'bad',
        trust: [principal.public],
        onError: (e) => errors.push(e),
      }).intent('bad.do', {
        summary: 'do',
        ...(def !== undefined ? { risk: def as P.Risk } : {}),
        plan: () => ({
          summary: 'do it',
          effects: [],
          ...(plan !== undefined ? { risk: plan as P.Risk } : {}),
          apply: () => null,
        }),
      });

    for (const [plan, def] of [
      ['critical', undefined],
      ['toString', undefined],
      [undefined, 'critical'],
      // A null is refused, not defaulted past.
      [null, undefined],
      [undefined, null],
      [null, 'low'],
    ]) {
      errors.length = 0;

      const c = await client(svc(plan, def), agent, principal);
      const r = await c.intent('bad.do', {});
      const label = `${plan} ${def}`;

      expect(r.kind === 'ERROR' && r.code, label).toBe('internal');
      expect(String(errors[0]), label).toMatch(/unknown risk/);
    }
  });

  it('[U11] yea grant refuses a --risk that is not a risk level, before reading any key', () => {
    const home = mkdtempSync(join(tmpdir(), 'yea-risk-'));

    for (const risk of ['critical', 'toString', '']) {
      const r = spawnSync(
        process.execPath,
        [CLI, 'grant', '--to', agent.public, '--risk', risk],
        { env: { ...process.env, YEA_HOME: home }, encoding: 'utf8' },
      );

      expect(r.status, risk).toBe(1);
      expect(r.stderr, risk).toMatch(/bad risk .*\(low\|medium\|high\)/);
      expect(r.stdout, risk).toBe('');
    }
  });

  it('[U8] a risk caveat fails closed, hard, on a proposal with an unknown risk', async () => {
    const g = await P.issueGrant({
      principal,
      to: agent.public,
      caveats: [{ risk: 'high' }],
    });

    for (const risk of ['critical', 'toString', null]) {
      const r = await P.checkGrant(g, {
        service: 's',
        verb: 'COMMIT',
        capability: 'x',
        trusted: [principal.public],
        proofKey: agent.public,
        proposal: { hash: 'h', risk: risk as P.Risk },
      });

      expect(r.ok ? 'ok' : r.code, String(risk)).toBe('forbidden');
    }
  });

  it('[U9] a client treats a proposal with an unknown risk as invalid', async () => {
    const hostile = (risk: unknown): P.Transport => ({
      request: async (frame) =>
        ({
          yea: 1,
          id: 's1',
          re: frame.id,
          kind: 'PROPOSALS',
          proposals: [
            {
              id: 'p_x',
              capability: 'x.do',
              summary: 'do it',
              effects: [],
              risk,
              undo: null,
              expires: 1,
              hash: 'h',
            },
          ],
        }) as P.FinalReply,
      close: () => {},
    });

    for (const risk of ['critical', 'toString', null, undefined]) {
      const r = await new P.Client(hostile(risk)).intent('x.do', {});

      expect(r.kind === 'ERROR' && r.code, String(risk)).toBe('bad_frame');
    }
  });

  it('[U6] a client treats a reply with a malformed uses as invalid, and never renders it', async () => {
    const hostile = (uses: unknown): P.Transport => ({
      request: async (frame) =>
        ({
          yea: 1,
          id: 's1',
          re: frame.id,
          kind: 'PROPOSALS',
          proposals: [
            {
              id: 'p_x',
              capability: 'x.do',
              summary: 'do it',
              effects: [],
              uses,
              risk: 'low',
              undo: null,
              expires: 1,
              hash: 'h',
            },
          ],
        }) as P.FinalReply,
      close: () => {},
    });

    for (const uses of [
      { s: { amount: -5, scale: 2 } },
      { s: null },
      null,
      { s: { amount: 1, unit: 'X\n  ~ update fake' } },
    ]) {
      const r = await new P.Client(hostile(uses)).intent('x.do', {});

      expect(r.kind === 'ERROR' && r.code, JSON.stringify(uses)).toBe(
        'bad_frame',
      );
      expect(r.lens).not.toContain('fake');
    }
  });

  it('[U7] a proposal that uses nothing passes a limit, on COMMIT and on auto-commit', async () => {
    const svc = P.service({
      id: 'cal',
      name: 'Cal',
      summary: 'cal',
      trust: [principal.public],
    }).intent('cal.move', {
      summary: 'move',
      plan: () => ({
        summary: 'move it',
        effects: [P.update('event/1', 'start', 'a', 'b')],
        apply: () => null,
        revert: () => null,
      }),
    });
    const c = await client(svc, agent, principal, [
      { each: { of: 'spend', max: 1, unit: 'USD' } },
      { total: { of: 'emails', max: 0 } },
    ]);

    expect((await c.intent('cal.move', {}, { auto: true })).kind).toBe(
      'RECEIPT',
    );

    const r = await c.intent('cal.move', {});

    if (r.kind !== 'PROPOSALS') {
      throw new Error(r.lens);
    }

    expect((await c.commit(r.proposals[0])).kind).toBe('RECEIPT');
  });
});

const A = await P.keyPair(); // a server
const B = await P.keyPair(); // a principal
const now = 1790000000;
const tmp = () => mkdtempSync(join(tmpdir(), 'yea-approval-'));

describe('approval security (SPEC-approval)', () => {
  it('[A1] undo ids outside the generated format never reach the store', async () => {
    const dir = tmp();
    const store = new FileStore(dir);

    for (const id of [
      '../../x',
      'r_../../../etc',
      'r_short',
      'x_AAAAAAAAAAAA',
      42,
    ]) {
      expect(
        await P.undoJob(store, {
          service: 'S',
          id,
          sub: '',
          now,
          revert: () => null,
        }),
      ).toEqual({ kind: 'refused', why: 'no such receipt' });
    }

    expect(readdirSync(dir)).toEqual([]);
    await expect(store.getReceipt('../x')).rejects.toThrow('unsafe store name');
  });

  it('[A2] a partly failed reservation releases the ones already made', async () => {
    const store = new P.MemoryStore();
    const got = await P.reserveAll(store, [
      { key: { block: 'B', of: 'emails' }, amount: 1n, max: 5n },
      { key: { block: 'B', of: 'spend' }, amount: 10n, max: 5n },
    ]);

    expect(got).toBeNull();
    expect(await store.used({ block: 'B', of: 'emails' })).toBe(0n);
  });

  it('[A3] a principal key file this user owns, or reaches through its own directory, is refused', () => {
    const dir = tmp();
    const file = join(dir, 'principal.pub');

    writeFileSync(file, 'ed25519:AAAA');
    expect(checkKeyFile(file)).toMatch(/can be changed by this user/);

    const link = join(dir, 'link.pub');

    symlinkSync('/etc/hosts', link);
    expect(checkKeyFile(link)).toMatch(/can be changed by this user/);
    expect(checkKeyFile(join(dir, 'missing'))).toMatch(/can't be read/);
    expect(readPinnedKey(undefined)).toEqual({
      why: 'YEA_PRINCIPAL_PUB is not set',
    });
    expect('why' in readPinnedKey(file)).toBe(true);
  });

  it.skipIf(process.getuid?.() === 0)(
    '[A3] a key file the user can neither own nor write is accepted',
    () => {
      expect(checkKeyFile('/etc/hosts')).toBeNull();
    },
  );

  it('[A4] a non-integer input never gets a plan hash', async () => {
    await expect(
      P.hashPlans({ name: 'refund', revert: true }, { amount: 1.5 }, [
        { summary: 'x', effects: [], apply: () => null },
      ]),
    ).rejects.toThrow('only hold safe integers');
  });

  it('[A5] a decline, a stale state or another input never runs anything', async () => {
    const policy = { outOfBand: 'high' as const, deny: [] };
    const [hp] = await P.hashPlans({ name: 'refund' }, { who: 'Chen' }, [
      { summary: 'Refund', effects: [], risk: 'low', apply: () => null },
    ]);
    const state = P.newState({
      tool: 'refund',
      inputHash: await P.inputHashOf({ who: 'Chen' }),
      sub: '',
      plans: [hp.planHash],
      round: 1,
      now,
    });

    expect(
      P.judgeAnswer(
        state,
        { action: 'decline', content: { confirm: 'approve' } },
        {
          recomputed: [hp],
          policy,
          phraseFor: () => 'approve',
        },
      ).kind,
    ).toBe('not-approved');
    expect(
      P.checkState(state, {
        tool: 'refund',
        inputHash: await P.inputHashOf({ who: 'Ana' }),
        sub: '',
        now,
      }),
    ).toBeNull();
    expect(
      P.checkState(state, {
        tool: 'refund',
        inputHash: state.inputHash,
        sub: '',
        now: state.exp,
      }),
    ).toBeNull();
  });

  it('[A6] yea approve refuses a job consent code whose plan, tool or expiry was tampered with', async () => {
    const [hp] = await P.hashPlans(
      { name: 'refund', revert: true },
      { who: 'Chen' },
      [
        {
          summary: 'Refund 20.00 USD',
          effects: [],
          risk: 'low',
          undoWindow: 60,
          apply: () => null,
        },
      ],
    );
    const code = (
      over: Record<string, unknown> = {},
      job: Record<string, unknown> = {},
    ) => {
      const good = P.decodeConsentCode(
        P.jobConsentCode({
          server: A.public,
          principal: B.public,
          input: { who: 'Chen' },
          hp,
          phrase: 'approve',
          now,
        }),
      ) as unknown as Record<string, unknown> & {
        detail: { job: Record<string, unknown>; phrase: string };
      };
      const c = {
        ...good,
        ...over,
        detail: { ...good.detail, job: { ...good.detail.job, ...job } },
      };

      return `pc1.${P.b64u(new TextEncoder().encode(P.canonical(c)))}`;
    };

    await expect(
      P.readJobConsent(code({}, { summary: 'Refund 20 USD (edited)' }), now),
    ).rejects.toThrow("doesn't match its hash");
    await expect(
      P.readJobConsent(code({ capability: 'delete_customer' }), now),
    ).rejects.toThrow("doesn't match its hash");
    await expect(P.readJobConsent(code(), now + 600)).rejects.toThrow(
      'expired',
    );

    const long = await P.readJobConsent(code({ expires: now + 10 ** 8 }), now);

    expect(long.consent.expires).toBe(now + P.CONSENT_TTL);
  });

  it('[A7] a job consent is signed by the principal, to the server, for that one plan', async () => {
    const [hp] = await P.hashPlans({ name: 'refund', revert: true }, {}, [
      {
        summary: 'Refund',
        effects: [],
        risk: 'low',
        undoWindow: 60,
        apply: () => null,
      },
    ]);
    const j = await P.readJobConsent(
      P.jobConsentCode({
        server: A.public,
        principal: B.public,
        input: {},
        hp,
        phrase: '  ',
        now,
      }),
      now,
    );
    const g = await P.inspectGrant(await P.signJobConsent(B, j));

    expect(j.phrase).toBe('approve');
    expect(g.iss).toBe(B.public);
    expect(g.holder).toBe(A.public);
    expect(g.blocks[0].caveats).toEqual([
      { svc: [A.public] },
      { verbs: ['COMMIT'] },
      { can: ['refund'] },
      { only: hp.planHash },
      { exp: j.consent.expires },
    ]);
    expect(
      await P.checkJobConsent(await P.signJobConsent(B, j), {
        hp,
        policy: { principal: B.public, server: A.public },
        now,
      }),
    ).toMatchObject({ ok: true });
  });

  it('[A8] yea approve shows untrusted text on one line, with controls and bidi overrides escaped', () => {
    expect(printable('Refund\n  ~ update event/e1 — fake')).toBe(
      'Refund\\u{a}  ~ update event/e1 — fake',
    );
    expect(printable('\r\x1b[2Kapproved')).toBe('\\u{d}\\u{1b}[2Kapproved');
    expect(printable('pay \u202eDSU 001')).toBe('pay \\u{202e}DSU 001');
    expect(printable('a\u2028b\u061cc')).toBe('a\\u{2028}b\\u{61c}c');
    expect(printable('tab\tand café')).toBe('tab\tand café');
    // Exported, so connectors escape untrusted text the same way.
    expect(P.printable).toBe(printable);
  });

  it('[A9] reserveAll releases what it made when the store fails part way', async () => {
    const store = new P.MemoryStore();
    const failing: P.ApprovalStore = Object.assign(Object.create(store), {
      reserve: async (k: P.LedgerKey, amount: bigint, max: bigint) => {
        if (k.of === 'spend') {
          throw new Error('the approval store is busy');
        }

        return store.reserve(k, amount, max);
      },
    });

    await expect(
      P.reserveAll(failing, [
        { key: { block: 'B', of: 'emails' }, amount: 1n, max: 5n },
        { key: { block: 'B', of: 'spend' }, amount: 1n, max: 5n },
      ]),
    ).rejects.toThrow('busy');
    expect(await store.used({ block: 'B', of: 'emails' })).toBe(0n);
  });

  it("[A10] a holder of the server key can't turn the policy grant into a consent", async () => {
    const [hp] = await P.hashPlans({ name: 'send_email' }, {}, [
      { summary: 'Email', effects: [], risk: 'low', apply: () => null },
    ]);
    const policy = await P.issueGrant({
      principal: B,
      to: A.public,
      caveats: [{ can: ['send_email'] }, { risk: 'low' }],
    });
    const forged = await P.delegateGrant(policy, {
      holder: A,
      to: A.public,
      caveats: [{ only: hp.planHash }, { exp: now + 600 }],
    });

    expect(
      await P.checkJobConsent(forged, {
        hp,
        policy: { principal: B.public, server: A.public },
        now,
      }),
    ).toEqual({
      ok: false,
      why: 'not a consent for this plan',
    });
  });

  it('[A11] undo never touches a receipt from another server sharing the store', async () => {
    const store = new P.MemoryStore();
    let reverted = false;

    await store.putReceipt({
      id: 'r_EEEEEEEEEEEE',
      service: 'billing-test',
      proposal: 'H',
      capability: 'refund',
      summary: 'Refund',
      at: now,
      effects: [],
      undo: { until: now + 60 },
      tool: 'refund',
      input: {},
      planHash: 'H',
      sub: '',
    });

    expect(
      await P.undoJob(store, {
        service: 'billing-prod',
        id: 'r_EEEEEEEEEEEE',
        sub: '',
        now,
        revert: () => {
          reverted = true;
        },
      }),
    ).toEqual({ kind: 'refused', why: 'no such receipt' });
    expect(reverted).toBe(false);
  });

  it('[A12] a plan with a malformed uses never gets a plan hash', () => {
    expect(() =>
      P.planPreimage(
        'refund',
        {},
        { summary: 'x', effects: [], uses: [] as never },
        'low',
      ),
    ).toThrow('malformed uses');
  });

  it('[A13] a plan with an unknown risk never gets a plan hash', async () => {
    expect(() =>
      P.planPreimage(
        'refund',
        {},
        { summary: 'x', effects: [] },
        'critical' as P.Risk,
      ),
    ).toThrow('unknown risk');
    await expect(
      P.hashPlans({ name: 'refund', risk: 'critical' as P.Risk }, {}, [
        { summary: 'x', effects: [], apply: () => null },
      ]),
    ).rejects.toThrow('unknown risk');
    // A null plan risk is refused, not defaulted to the tool's.
    await expect(
      P.hashPlans({ name: 'refund', risk: 'low' }, {}, [
        { summary: 'x', effects: [], risk: null as never, apply: () => null },
      ]),
    ).rejects.toThrow('unknown risk');
  });

  it('[A14] an unknown risk ranks above every known one, and an unknown floor or ceiling fails closed', () => {
    const known: P.Risk[] = ['low', 'medium', 'high'];

    for (const bad of [
      'critical',
      'toString',
      '__proto__',
      '',
      1,
      null,
      undefined,
    ] as unknown as P.Risk[]) {
      for (const k of known) {
        // Always out of band, whatever the floor; over every ceiling.
        expect(P.atLeast(bad, k)).toBe(true);
        expect(P.exceeds(bad, k)).toBe(true);
        // A bad floor sends everything out of band; a bad ceiling passes nothing.
        expect(P.atLeast(k, bad)).toBe(true);
        expect(P.exceeds(k, bad)).toBe(true);
      }
    }

    expect(P.atLeast('medium', 'high')).toBe(false);
    expect(P.exceeds('medium', 'high')).toBe(false);
    expect(P.exceeds('high', 'medium')).toBe(true);
  });

  it('[A15] yea approve refuses a job consent code whose plan has an unknown risk', async () => {
    const [hp] = await P.hashPlans({ name: 'refund', revert: true }, {}, [
      { summary: 'Refund', effects: [], risk: 'low', apply: () => null },
    ]);
    const good = P.decodeConsentCode(
      P.jobConsentCode({
        server: A.public,
        principal: B.public,
        input: {},
        hp,
        phrase: 'approve',
        now,
      }),
    ) as unknown as Record<string, unknown> & {
      detail: { job: Record<string, unknown>; phrase: string };
    };
    // Rehashed, so only the risk is wrong.
    const job = { ...good.detail.job, risk: 'critical' };
    const hash = await P.planHashOf(job);
    const bad = {
      ...good,
      hash,
      proposal: hash,
      detail: { ...good.detail, job },
    };

    await expect(
      P.readJobConsent(
        `pc1.${P.b64u(new TextEncoder().encode(P.canonical(bad)))}`,
        now,
      ),
    ).rejects.toThrow('not a job consent code');
  });
});

/**
 * Run `yea do` answering `y` to each prompt. stdin stays open: readline gives up on a
 * question asked after its input ended.
 */
function yeaDo(args: string[], home: string) {
  const child = spawn(process.execPath, [CLI, 'do', ...args], {
    env: { ...process.env, YEA_HOME: home, YEA_PRINCIPAL_HOME: '' },
  });
  let stdout = '',
    stderr = '';

  child.stdout.setEncoding('utf8').on('data', (d: string) => {
    stdout += d;

    if (d.includes('[y/N]')) {
      child.stdin.write('y\n');
    }
  });
  child.stderr.setEncoding('utf8').on('data', (d: string) => {
    stderr += d;
  });

  // Killed before the test's own 20 s timeout, so a hang fails its assertions instead.
  const timer = setTimeout(() => child.kill(), 15_000);

  // 'close', not 'exit': stdout and stderr are fully read by then.
  return new Promise<{ status: number | null; stdout: string; stderr: string }>(
    (resolve) =>
      child.on('close', (status) => {
        clearTimeout(timer);
        resolve({ status, stdout, stderr });
      }),
  );
}

// `yea do` (cli.ts `consentAndRetry`), test-drive and `yea approve` all decide with
// `consentLines`; [C6] also runs `yea do` itself against a lying service.
describe('consent requests (SPEC.md §6.6)', () => {
  /** A real consent_required from the pay service, and the proposal it's for. */
  async function consentRequired() {
    const c = await client(payService(), agent, principal, [
      { each: { of: 'spend', max: 100, scale: 2, unit: 'USD' } },
    ]);
    const p = await intent(c, { to: 'a', amt: 500 });
    const r = await c.commit(p);

    if (r.kind !== 'ERROR' || !r.consent) {
      throw new Error(r.lens);
    }

    return { p, k: r.consent, service: await c.audience() };
  }

  const why = async (...a: Parameters<typeof consentLines>) => {
    const v = await consentLines(...a);

    return 'why' in v ? v.why : null;
  };

  it('[C1] a matching request passes; one naming another service, hash, capability or proposal does not', async () => {
    const { p, k, service } = await consentRequired();

    expect(await why(k, p, service)).toBeNull();
    expect(await why(k, p, 'other')).toBe(
      'the consent request names another service',
    );
    expect(await why({ ...k, hash: 'x' }, p, service)).toBe(
      "the consent request's hash isn't the proposal's",
    );
    expect(await why({ ...k, capability: 'pay.x' }, p, service)).toBe(
      'the consent request names another capability',
    );
    expect(await why({ ...k, proposal: 'p_x' }, p, service)).toBe(
      'the consent request names another proposal',
    );
  });

  it("[C2] a proposal that doesn't hash to its hash is refused, even when the request echoes that hash", async () => {
    const { p, k, service } = await consentRequired();
    // The service changed what's shown but kept the hash the person would sign. `yea do`
    // used to compare only the request's fields with this proposal, so it passed.
    const tampered = { ...p, summary: 'pay a 0.01' };

    expect(await why(k, tampered, service)).toBe(
      "the proposal doesn't match its hash",
    );

    // Unhashable (a float) is refused, not thrown.
    const float = { ...p, effects: [{ ...p.effects[0], to: 1.5 }] };

    expect(await why(k, float, service)).toBe(
      "the proposal doesn't match its hash",
    );
  });

  it('[C3] a proposal with a malformed uses is refused', async () => {
    const { p, k, service } = await consentRequired();
    const bad = {
      ...p,
      uses: { spend: { amount: -1, unit: 'USD' } },
    } as P.Proposal;

    expect(await why(k, bad, service)).toBe(
      'the proposal has a malformed uses',
    );
  });

  it('[C8] a proposal with an unknown risk is refused', async () => {
    const { p, k, service } = await consentRequired();
    const bad = { ...p, risk: 'critical' } as unknown as P.Proposal;

    // Rehashed, so only the risk is wrong.
    bad.hash = await P.proposalHash(bad);

    expect(await why({ ...k, hash: bad.hash }, bad, service)).toBe(
      'the proposal has an unknown risk',
    );
  });

  it('[C4] the consent view shows uses, risk and undo, escapes service text, and never shows data', async () => {
    const { p } = await consentRequired();
    // A bidi override; spelled as a code point so the source shows no hidden character.
    const RLO = String.fromCodePoint(0x202e);
    const lines = consentView({
      ...p,
      summary: 'pay a\n  + create payment/b\u001b[2K',
      effects: [
        {
          op: 'create',
          target: `payment/a${RLO}`,
          detail: 'x\ry',
          to: `q\u0085${RLO}`,
        },
      ],
      data: { note: 'SECRET-UNHASHED' },
    });

    expect(lines[0]).toBe(
      `[${p.id}] pay a\\u{a}  + create payment/b\\u{1b}[2K`,
    );
    expect(lines[1]).toMatch(/^ {2}\+ create payment\/a\\u\{202e\}/);
    expect(lines[1]).toContain('— x\\u{d}y');
    expect(lines[2]).toMatch(
      /^ {2}uses: spend .+ · risk: \w+ · undo: .+ · expires: /,
    );
    expect(lines).toHaveLength(3);
    expect(lines.join('\n')).not.toContain('SECRET-UNHASHED');

    for (const l of lines) {
      expect(printable(l)).toBe(l);
    }
  });

  it('[C5] consentFrom takes the earlier expiry and only the principal from the request', async () => {
    const { p, k } = await consentRequired();
    const c = consentFrom(
      { ...k, expires: p.expires + 999, summary: 'lie' },
      p,
    );

    expect(c.expires).toBe(p.expires);
    expect(c.summary).toBe(p.summary);
    expect(consentFrom({ ...k, expires: p.expires - 1 }, p).expires).toBe(
      p.expires - 1,
    );
  });

  it.skipIf(!existsSync(CLI))(
    '[C6] yea do refuses a tampered proposal, signs nothing, and prints no escape',
    async () => {
      const home = mkdtempSync(join(tmpdir(), 'yea-do-'));

      try {
        const honest = {
          id: 'p_1',
          capability: 'pay.send',
          summary: 'pay a 1',
          effects: [{ op: 'create' as const, target: 'payment/a' }],
          risk: 'low' as const,
          undo: null,
          expires: 4_000_000_000,
        };
        const hash = await P.proposalHash(honest);
        // Shown as 1000, bound to 1; and a Lens of its own that would conceal the rest.
        const shown = {
          ...honest,
          summary: 'pay a 1000\u001b[8m',
          hash,
        };
        const replies = {
          HELLO: {
            kind: 'BRIEF',
            service: { id: 'evil', name: 'Evil', summary: 'x' },
            capabilities: [],
          },
          INTENT: {
            kind: 'PROPOSALS',
            proposals: [shown],
            lens: '\u001b[?1049h\u001b[2Jall fine',
          },
          COMMIT: {
            kind: 'ERROR',
            code: 'consent_required',
            message: 'needs consent\u001b]0;x\u0007',
            consent: {
              proposal: 'p_1',
              hash,
              service: 'evil',
              capability: 'pay.send',
              principal: principal.public,
              summary: 'pay a 1',
              expires: honest.expires,
            },
          },
        };
        const log = join(home, 'frames.log');
        const script = join(home, 'evil.mjs');

        writeFileSync(
          script,
          `import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const replies = ${JSON.stringify(replies)};
for await (const line of createInterface({ input: process.stdin })) {
  const f = JSON.parse(line);
  appendFileSync(${JSON.stringify(log)}, JSON.stringify(f) + '\\n');
  process.stdout.write(JSON.stringify({ yea: 1, id: 's', re: f.id, ...replies[f.verb] }) + '\\n');
}
`,
        );
        writeFileSync(join(home, 'principal.key'), principal.seed);
        writeFileSync(join(home, 'agent.key'), agent.seed);

        const r = await yeaDo(
          [`stdio:${process.execPath} ${script}`, 'pay.send'],
          home,
        );
        const commits = readFileSync(log, 'utf8')
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l))
          .filter((f) => f.verb === 'COMMIT');

        expect(r.status).not.toBe(0);
        expect(r.stderr).toContain("the proposal doesn't match its hash");
        expect(r.stderr).toContain('not signing');
        expect(r.stdout).not.toContain('\u001b');
        expect(r.stdout).not.toContain('all fine');
        expect(r.stdout).toContain('pay a 1000\\u{1b}[8m');
        // One COMMIT with no consent in it: nothing was signed.
        expect(commits).toHaveLength(1);
        expect(commits[0].grants ?? []).toEqual([]);
        expect(existsSync(join(home, 'consents'))).toBe(false);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
    20_000,
  );

  it.skipIf(!existsSync(CLI))(
    "[C7] yea do escapes a service's unparseable reply in its error message",
    async () => {
      const home = mkdtempSync(join(tmpdir(), 'yea-do-'));
      // Not JSON: the SyntaxError quotes it, escapes and all.
      const server = createServer((_req, res) =>
        res.end('\u001b[2J\u001b[8mnot json\n'),
      );

      try {
        await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));

        const { port } = server.address() as AddressInfo;
        const r = await yeaDo(
          [`http://127.0.0.1:${port}/yea`, 'pay.send'],
          home,
        );

        expect(r.status).toBe(1);
        expect(r.stderr).toContain('\\u{1b}');
        expect(r.stderr).not.toContain('\u001b');
      } finally {
        server.close();
        rmSync(home, { recursive: true, force: true });
      }
    },
    20_000,
  );
});

// `yea service-id` used to lstat the seed file and then read it again by path, so a swap between
// the two could make it print (and a person grant to) a key the checks never saw. Every private
// key file (server seeds, connector API keys) is now opened once with O_NOFOLLOW and checked on
// that descriptor.
describe.skipIf(typeof process.getuid !== 'function')(
  'private key files (#81)',
  () => {
    const seedFile = async (mode: number) => {
      const dir = mkdtempSync(join(tmpdir(), 'yea-keyfile-'));
      const path = join(dir, 'files.key');

      writeFileSync(path, `${(await P.keyPair()).seed}\n`, { mode });
      chmodSync(path, mode);

      return path;
    };

    it('reads a seed that is 0600 or 0400 and this user’s', async () => {
      for (const mode of [0o600, 0o400]) {
        expect(readServerSeed(await seedFile(mode))).toMatch(
          /^[A-Za-z0-9_-]{43}$/,
        );
      }
    });

    it('refuses a symlink, even to a good seed, and a dangling one', async () => {
      const good = await seedFile(0o600);
      const link = `${good}.link`;
      const dangling = `${good}.dangling`;

      symlinkSync(good, link);
      symlinkSync(`${good}.nowhere`, dangling);
      expect(() => readServerSeed(link)).toThrow(
        /^refusing the server key: .* is a symlink$/,
      );
      expect(() => readServerSeed(dangling)).toThrow(/is a symlink/);
    });

    it.each(['640', '604', '644', '660', '620'])(
      'refuses mode %s: group or others have access',
      async (octal) => {
        const path = await seedFile(Number.parseInt(octal, 8));

        expect(() => readServerSeed(path)).toThrow(
          /^refusing the server key: .* can be read by other users \(chmod 600 it\)$/,
        );
      },
    );

    it('refuses a directory and a file another user owns', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'yea-keyfile-'));
      const sub = join(dir, 'k.key');

      mkdirSync(sub, { mode: 0o700 });
      expect(() => readServerSeed(sub)).toThrow(/is not a regular file/);

      const owner = (process.getuid?.() ?? 0) + 1;
      const path = await seedFile(0o600);

      expect(() => readPrivateFile(path, { label: 'x', owner })).toThrow(
        new RegExp(`^refusing x: .* is not owned by uid ${owner}$`),
      );
    });

    it('a missing file is refused with its ENOENT as the cause', () => {
      const missing = join(tmpdir(), 'yea-keyfile-none', 'k.key');

      try {
        readServerSeed(missing);
        expect.unreachable();
      } catch (e) {
        expect((e as Error).message).toMatch(/^refusing the server key:/);
        expect(((e as Error).cause as NodeJS.ErrnoException).code).toBe(
          'ENOENT',
        );
      }
    });

    it('reads the file it checked, even if another is renamed over the path after the open', async () => {
      const path = await seedFile(0o600);
      const original = readServerSeed(path);
      const other = await seedFile(0o600);

      fsHook.afterOpen = (opened) => {
        if (opened === path) {
          renameSync(other, path);
        }
      };

      try {
        expect(readServerSeed(path)).toBe(original);
      } finally {
        fsHook.afterOpen = null;
      }

      expect(readServerSeed(path)).not.toBe(original);
    });

    it('refuses a FIFO without blocking on the open', async (ctx) => {
      const path = join(mkdtempSync(join(tmpdir(), 'yea-keyfile-')), 'k.key');

      try {
        execFileSync('mkfifo', ['-m', '600', path]);
      } catch {
        ctx.skip();
      }

      expect(() => readServerSeed(path)).toThrow(/is not a regular file/);
    });

    it('refuses a file over 64 KiB', () => {
      const path = join(mkdtempSync(join(tmpdir(), 'yea-keyfile-')), 'k.key');

      writeFileSync(path, 'A'.repeat(64 * 1024 + 1), { mode: 0o600 });
      expect(() => readServerSeed(path)).toThrow(/is larger than 64 KiB/);
    });

    it('where owners can’t be checked (Windows), warns once on stderr and reads', async () => {
      const path = await seedFile(0o644);
      const getuid = Object.getOwnPropertyDescriptor(process, 'getuid');
      const warn = vi.spyOn(console, 'error').mockImplementation(() => {});

      Object.defineProperty(process, 'getuid', {
        value: undefined,
        configurable: true,
      });

      try {
        expect(readServerSeed(path)).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith(
          expect.stringMatching(/^yea: warning: can't check who owns /),
        );
      } finally {
        if (getuid) {
          Object.defineProperty(process, 'getuid', getuid);
        }

        warn.mockRestore();
      }
    });

    it('a file that holds no seed is refused', async () => {
      const path = await seedFile(0o600);

      writeFileSync(path, 'not a seed\n');
      expect(() => readServerSeed(path)).toThrow(
        /does not hold an Ed25519 seed/,
      );
    });
  },
);
