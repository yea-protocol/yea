/**
 * The README's quickstart (examples/guard-quickstart.ts, shown there whole) does what the README
 * says: `send_email` shows the server's plan and asks for the recipient, a wrong phrase asks
 * again, and the right one sends. Three wrong phrases, or a client that can't show forms, send
 * nothing. The handler logs to stderr, since stdout is the MCP transport. The file also runs as
 * its own process, as Claude Code starts it: the lines that start it are in the README too.
 */
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from '../../examples/guard-quickstart.js';
import { connectProcess } from './harness.js';
import { connect, type Kind, textOf, tmp, world } from './helpers.js';

const EXAMPLE = fileURLToPath(
  new URL('../../examples/guard-quickstart.ts', import.meta.url),
);

const email = { to: 'ana@example.com', subject: 'Q3 report' };
const sent = 'email ana@example.com: Q3 report';
const wrong = { action: 'accept', content: { confirm: 'approve' } } as const;

afterEach(() => {
  vi.restoreAllMocks();
});

/** A client of `kind` on the example's server, with what it writes to stdout and stderr. */
async function mail(kind: Kind) {
  const w = await world({ name: 'mail' });
  const conn = await connect(kind, () => createServer(w.approvals));
  const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
  const stdout = [
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true),
    vi.spyOn(console, 'log').mockImplementation(() => {}),
    vi.spyOn(console, 'info').mockImplementation(() => {}),
  ];
  const logged = () => stderr.mock.calls.filter(([m]) => m === sent).length;

  return { conn, stdout, logged };
}

describe.each<Kind>(['2026', '2025', 'stdio-2026'])(
  'on a %s client',
  (kind) => {
    it('asks with the plan, asks again after a wrong phrase, and sends once the recipient is typed', async () => {
      const m = await mail(kind);

      m.conn.answers.push(wrong, {
        action: 'accept',
        content: { confirm: 'ana@example.com' },
      });

      const r = await m.conn.call(email, 'send_email');

      expect(r.isError).toBeFalsy();
      expect(textOf(r)).toBe('sent to ana@example.com');
      expect(m.logged()).toBe(1);
      expect(m.conn.elicited).toHaveLength(2);
      expect(m.conn.elicited[0].message).toContain(
        'Email ana@example.com: Q3 report',
      );
      expect(m.conn.elicited[0].message).toContain(
        "send_email can't be undone",
      );
      expect(m.conn.elicited[0].requestedSchema).toMatchObject({
        properties: {
          confirm: { description: 'Type "ana@example.com" to approve.' },
        },
      });

      for (const spy of m.stdout) {
        expect(spy).not.toHaveBeenCalled();
      }
    });

    it('sends nothing after three wrong phrases', async () => {
      const m = await mail(kind);

      m.conn.answers.push(wrong, wrong, wrong);

      const r = await m.conn.call(email, 'send_email');

      expect(textOf(r)).toMatch(/not approved after 3 tries/);
      expect(m.conn.elicited).toHaveLength(3);
      expect(m.logged()).toBe(0);
    });
  },
);

it('sends nothing to a client that cannot show forms', async () => {
  const m = await mail('2026-no-elicit');
  const r = await m.conn.call(email, 'send_email');

  expect(r.isError).toBe(true);
  expect(textOf(r)).toContain('yea approve');
  expect(m.logged()).toBe(0);
});

// Node runs the file itself with type stripping (22.18+), so this skips on Node 20.
describe.skipIf(!process.features.typescript)('run as its own process', () => {
  it('starts on stdio, asks, and sends once the recipient is typed', async () => {
    const m = await connectProcess(process.execPath, [EXAMPLE], {
      YEA_HOME: tmp(),
    });

    try {
      m.answers.push(wrong, {
        action: 'accept',
        content: { confirm: 'ana@example.com' },
      });

      const r = await m.call(email, 'send_email');

      expect(textOf(r)).toBe('sent to ana@example.com');
      expect(m.elicited).toHaveLength(2);
      await vi.waitFor(() => expect(m.stderr()).toContain(sent));
    } finally {
      await m.close();
    }
  }, 20_000);
});
