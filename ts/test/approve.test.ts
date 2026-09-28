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
  it('uses --to, else the local agent key when the code names it or no one', () => {
    expect(
      P.consentRecipient({ code: agent.public, local: null, to: other.public }),
    ).toEqual({ key: other.public });
    expect(
      P.consentRecipient({ code: undefined, local: agent.public }),
    ).toEqual({ key: agent.public });
    expect(
      P.consentRecipient({ code: agent.public, local: agent.public }),
    ).toEqual({ key: agent.public });
  });

  it("never trusts the code's unsigned agent on its own", () => {
    const why = (o: Parameters<typeof P.consentRecipient>[0]) => {
      const r = P.consentRecipient(o);

      return 'why' in r ? r.why : '';
    };

    expect(why({ code: agent.public, local: null })).toMatch(/pass --to <key>/);
    expect(why({ code: other.public, local: agent.public })).toMatch(
      /pass --to <key> to say which/,
    );
    expect(why({ code: 'ed25519:short', local: null })).toMatch(
      /not an ed25519/,
    );
    expect(why({ code: 42, local: null })).toMatch(/not an ed25519/);
    expect(why({ code: undefined, local: null, to: 'bob' })).toMatch(/--to/);
    expect(why({ code: undefined, local: null })).toMatch(/no agent key/);
  });
});

/** approveConsentCode with a scripted person: what they saw, and what was saved. */
async function approveWith(
  code: string,
  o: { localAgent?: string | null; to?: string; yes?: boolean } = {},
) {
  const shown: string[] = [];
  const saved: { token: string; hash: string }[] = [];
  const r = await P.approveConsentCode({
    principal,
    code,
    localAgent: o.localAgent ?? null,
    to: o.to,
    io: {
      print: (line) => shown.push(line),
      confirm: async () => o.yes ?? true,
    },
    save: (token, hash) => saved.push({ token, hash }),
  });

  return { r, shown: shown.join('\n'), saved };
}

describe('approveConsentCode', () => {
  it('signs to the local agent and saves it there', async () => {
    const code = await codeFor(agent.public);
    const { r, shown, saved } = await approveWith(code, {
      localAgent: agent.public,
    });

    expect(r.ok && r.saved).toBe(true);
    expect(shown).toContain(`consent issued to agent: ${agent.public}`);
    expect(saved).toHaveLength(1);

    const info = await P.inspectGrant(r.ok ? r.token : '');

    expect(info.holder).toBe(agent.public);
    expect(info.iss).toBe(principal.public);
    expect(saved[0].hash).toBe(P.decodeConsentCode(code).hash);
  });

  it('signs to --to for another machine, and saves nothing here', async () => {
    const { r, saved } = await approveWith(await codeFor(other.public), {
      localAgent: agent.public,
      to: other.public,
    });

    expect(r.ok && r.agent).toBe(other.public);
    expect(r.ok && r.saved).toBe(false);
    expect(saved).toEqual([]);
  });

  it("with no local agent key, needs --to, suggesting the code's agent with a fingerprint", async () => {
    const { r } = await approveWith(await codeFor(other.public));
    const fp = await P.keyFingerprint(other.public);

    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.why).toContain(
      `The code suggests --to ${other.public} (fingerprint ${fp})`,
    );
  });

  it('a no signs nothing, and a code whose detail was changed is refused before asking', async () => {
    expect(
      (
        await approveWith(await codeFor(agent.public), {
          localAgent: agent.public,
          yes: false,
        })
      ).r,
    ).toEqual({ ok: false, why: 'not approved' });

    const c = P.decodeConsentCode(await codeFor(agent.public));
    const forged = P.consentCode(
      { ...c, summary: c.summary },
      { ...(c.detail as P.Proposal), summary: 'free' },
      { agent: agent.public },
    );
    const { r, shown } = await approveWith(forged, {
      localAgent: agent.public,
    });

    expect(r.ok ? '' : r.why).toMatch(/doesn't match its hash/);
    expect(shown).toBe('');
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

  it("without a local agent key, requires --to and suggests the code's agent", async () => {
    const r = approve(await codeFor(other.public));

    expect(r.status).toBe(1);
    expect(r.out).toContain(`The code suggests --to ${other.public}`);
    expect(r.out).not.toContain('at shop.example');
  });

  it('refuses a malformed agent before showing anything', async () => {
    const r = approve(await codeFor('ed25519:not-a-key'));

    expect(r.status).toBe(1);
    expect(r.out).toMatch(/not an ed25519 key/);
    expect(r.out).not.toContain('at shop.example');
  });
});
