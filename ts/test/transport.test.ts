import { type AddressInfo, createServer } from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
import { calendar } from '../../examples/calendar.ts';
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
