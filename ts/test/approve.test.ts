// `yea approve` with a protocol consent code's `agent` field (SPEC-bridge, "yea approve").
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { shop } from '../../examples/shop.ts';
import * as P from '../src/index.js';

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

const principal = await P.keyPair(),
  agent = await P.keyPair(),
  other = await P.keyPair();

/** A real protocol code for a shop order, naming `named` as the agent. */
async function codeFor(named: unknown) {
  const c = new P.Client(P.local(shop({ trust: [principal.public] })), {
    key: agent.seed,
    grants: [await P.issueGrant({ principal, to: agent.public })],
  });
  const r = await c.intent('shop.order', {
    items: [{ sku: 'm001', qty: 1 }],
    deliver: '2030-01-01',
  });

  if (r.kind !== 'PROPOSALS') {
    throw new Error(r.lens);
  }

  const p = r.proposals[0];

  return P.consentCode(
    {
      proposal: p.id,
      hash: p.hash,
      service: 'shop.example',
      capability: p.capability,
      principal: principal.public,
      summary: p.summary,
      expires: p.expires,
    },
    p,
    { agent: named as string },
  );
}

/** Run `yea approve` in a home with the principal key and, optionally, an agent key. */
function approve(code: string, o: { agentKey?: P.KeyPair; to?: string } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'yea-approve-'));

  writeFileSync(join(home, 'principal.key'), principal.seed);

  if (o.agentKey) {
    writeFileSync(join(home, 'agent.key'), o.agentKey.seed);
  }

  const r = spawnSync(
    process.execPath,
    [CLI, 'approve', code, ...(o.to ? ['--to', o.to] : [])],
    {
      env: { ...process.env, YEA_HOME: home, YEA_PRINCIPAL_HOME: '' },
      input: '',
      encoding: 'utf8',
    },
  );

  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

describe('consentRecipient', () => {
  it('uses --to, else the local agent key, else the code’s agent', () => {
    expect(
      P.consentRecipient({ code: agent.public, local: null, to: other.public }),
    ).toEqual({ key: other.public });
    expect(
      P.consentRecipient({ code: undefined, local: agent.public }),
    ).toEqual({ key: agent.public });
    expect(P.consentRecipient({ code: agent.public, local: null })).toEqual({
      key: agent.public,
    });
    expect(
      P.consentRecipient({ code: agent.public, local: agent.public }),
    ).toEqual({ key: agent.public });
  });

  it('refuses a malformed agent, a malformed --to, a differing local key, and none at all', () => {
    const why = (o: Parameters<typeof P.consentRecipient>[0]) => {
      const r = P.consentRecipient(o);

      return 'why' in r ? r.why : '';
    };

    expect(why({ code: 'ed25519:short', local: null })).toMatch(
      /not an ed25519/,
    );
    expect(why({ code: 42, local: null })).toMatch(/not an ed25519/);
    expect(why({ code: undefined, local: null, to: 'bob' })).toMatch(/--to/);
    expect(why({ code: other.public, local: agent.public })).toMatch(
      /pass --to <key>/,
    );
    expect(why({ code: undefined, local: null })).toMatch(/no agent key/);
  });
});

describe.skipIf(!existsSync(CLI))('yea approve with a code’s agent', () => {
  it('requires --to when the code names another agent than the local key', async () => {
    const r = approve(await codeFor(other.public), { agentKey: agent });

    expect(r.status).toBe(1);
    expect(r.out).toMatch(/pass --to <key> to say which/);
  });

  it('with --to, shows the proposal and the agent, then needs a terminal', async () => {
    const r = approve(await codeFor(other.public), {
      agentKey: agent,
      to: other.public,
    });

    expect(r.out).toContain('at shop.example:');
    expect(r.out).toContain(`consent issued to agent: ${other.public}`);
    expect(r.out).toMatch(/approval needs an interactive terminal/);
  });

  it("without a local agent key, uses the code's agent", async () => {
    const r = approve(await codeFor(other.public));

    expect(r.out).toContain(`consent issued to agent: ${other.public}`);
    expect(r.out).toMatch(/approval needs an interactive terminal/);
  });

  it('refuses a malformed agent before showing anything', async () => {
    const r = approve(await codeFor('ed25519:not-a-key'));

    expect(r.status).toBe(1);
    expect(r.out).toMatch(/not an ed25519 key/);
    expect(r.out).not.toContain('at shop.example');
  });
});
