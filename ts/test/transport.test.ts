import { type AddressInfo, createServer } from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
import { calendar } from '../../examples/calendar.ts';
import { queryBudget } from '../src/http.js';
import * as P from '../src/index.js';
import { connect, listen, serveHttp } from '../src/node.js';

const closers: (() => void)[] = [];

/** Whether this host can listen on the IPv6 loopback. */
const ipv6 = await new Promise<boolean>((resolve) => {
  const probe = createServer();

  probe.once('error', () => resolve(false));
  probe.listen(0, '::1', () => probe.close(() => resolve(true)));
});

afterAll(() => {
  for (const close of closers) {
    close();
  }
});

describe('transports', async () => {
  const principal = await P.keyPair();
  const agent = await P.keyPair();
  const grant = await P.issueGrant({ principal, to: agent.public });

  it('TCP (yea://) with multiplexed requests', async () => {
    const server = await listen(calendar({ trust: [principal.public] }), {
      port: 0,
    });

    closers.push(() => server.close());

    const port = (server.address() as AddressInfo).port;
    const c = await connect(`yea://127.0.0.1:${port}`, {
      key: agent.seed,
      grants: [grant],
    });

    closers.push(() => c.close());

    const [a, b, h] = await Promise.all([
      c.ask('calendar.agenda'),
      c.ask('calendar.free', { day: '2030-01-01' }),
      c.hello(),
    ]);

    expect([a.kind, b.kind, h.kind]).toEqual(['ANSWER', 'ANSWER', 'BRIEF']);

    const p = await c.intent('calendar.cancel', { event: 'e1' });

    if (p.kind !== 'PROPOSALS') {
      throw new Error(p.lens);
    }

    expect((await c.commit(p.proposals[0])).kind).toBe('RECEIPT');
  });

  // new URL('yea://[::1]:p').hostname keeps the brackets, which net.connect can't resolve.
  it.skipIf(!ipv6)('TCP to an IPv6 literal (yea://[::1]:port)', async () => {
    const server = await listen(calendar({ trust: [principal.public] }), {
      port: 0,
      host: '::1',
    });

    closers.push(() => server.close());

    const port = (server.address() as AddressInfo).port;
    const c = await connect(`yea://[::1]:${port}`, {
      key: agent.seed,
      grants: [grant],
    });

    closers.push(() => c.close());
    expect((await c.hello()).kind).toBe('BRIEF');
  });

  it('HTTP bridge with discovery', async () => {
    const server = await serveHttp(calendar({ trust: [principal.public] }), {
      port: 0,
    });

    closers.push(() => server.close());

    const port = (server.address() as AddressInfo).port;
    const disc = await (
      await fetch(`http://127.0.0.1:${port}/.well-known/yea`)
    ).json();

    expect(disc.kind).toBe('BRIEF');
    expect(disc.endpoint).toBe('/yea');

    const c = await connect(`http://127.0.0.1:${port}/yea`, {
      key: agent.seed,
      grants: [grant],
    });
    const p = await c.intent('calendar.cancel', { event: 'e1' });

    if (p.kind !== 'PROPOSALS') {
      throw new Error(p.lens);
    }

    expect((await c.commit(p.proposals[0])).kind).toBe('RECEIPT');
  });

  // #193: `Number(q) || undefined` let -5, Infinity and 0x10 through as a budget.
  it('?budget= reads like a frame budget', async () => {
    expect(['800', '800.0', '1e3', '+800', '.8e3'].map(queryBudget)).toEqual([
      800, 800, 1000, 800, 800,
    ]);

    const rejected = [
      null,
      '',
      ' ',
      '0',
      '-5',
      '0.5',
      '1.5',
      'Infinity',
      '-Infinity',
      'NaN',
      '1e400',
      '0x10',
      '0b11',
      '0o7',
      '1_000',
      ' 800',
      '\u0663',
      '\u00b2',
      '\uff18\uff10\uff10',
    ];

    expect(rejected.map(queryBudget)).toEqual(rejected.map(() => undefined));

    const brief = async (q: string) =>
      (await (
        await P.fetchHandler(calendar({ trust: [] }))(
          new Request(`http://svc.test/.well-known/yea${q}`),
        )
      ).json()) as { more?: unknown };
    const [small, same, hex, negative] = await Promise.all(
      ['?budget=40', '?budget=40.0', '?budget=0x28', '?budget=-40'].map(brief),
    );

    // Fitted to 40 either way; hex and negative budgets get the default instead.
    expect([small.more, same.more].every(Boolean)).toBe(true);
    expect([hex.more, negative.more]).toEqual([undefined, undefined]);
  });

  it('bad frames get bad_frame errors', async () => {
    const svc = calendar({ trust: [] });

    expect((await svc.handle({ nope: 1 })).kind).toBe('ERROR');
    expect(
      (
        (await svc.handle({
          yea: 1,
          id: 'x',
          verb: 'PATCH',
        })) as P.ErrorReply
      ).code,
    ).toBe('bad_frame');
  });
});
