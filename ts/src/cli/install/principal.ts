/**
 * `yea install`'s principal (approval) key: created here only when asked, then a starter policy
 * signed with it, and how to pin it for servers that check approvals.
 */
import type { KeyPair } from '../../crypto.js';
import { type Caveat, inspectGrant, issueGrant } from '../../grants.js';
import { loadGrants, principalKey, saveGrant } from '../../home.js';
import { unixNow } from '../../util.js';
import { confirm, pinRecipe, self } from '../shared.js';

/**
 * Find or (when asked) create the principal key here, and sign the agent a starter policy with
 * it if the agent has no grant yet.
 */
export async function installPrincipal(
  a: KeyPair,
  o: { yes?: boolean; 'with-principal'?: boolean },
) {
  const p = await principalHere(a, o);

  if (p && !loadGrants('grants').length) {
    await installDefaultPolicy(p, a);
  }
}

/**
 * The principal (approval) key should live where agents can't read it. Only create it here
 * when asked: --with-principal, or a yes at the interactive prompt.
 */
async function principalHere(
  a: KeyPair,
  o: { yes?: boolean; 'with-principal'?: boolean },
): Promise<KeyPair | null> {
  const existing = await principalKey();

  if (existing) {
    console.log(`principal   ${existing.public}`);
    printPin(existing);

    return existing;
  }

  let create = !!o['with-principal'];

  if (!create && process.stdin.isTTY && !o.yes) {
    create = await confirm(
      'Create your approval (principal) key on this machine too? Handy for trying YEA, but an agent with shell access could read it. [y/N] › ',
    );
  }

  if (!create) {
    console.log(
      `principal   not on this machine (recommended). On the device that holds it, run:\n              yea grant --to ${a.public} --risk low --each spend=25.00USD --total spend=100.00USD --exp 30d\n            and save the token here with: ${self('grant-import <token>')}   (or re-run with --with-principal to try things quickly)`,
    );

    return null;
  }

  const p = await principalKey(true);

  console.log(
    `principal   ${p.public} (on this machine: fine for trying things; see SECURITY.md for real use)`,
  );
  printPin(p);

  return p;
}

/** How to pin `p` for servers that check approvals, which accept none until it is. */
function printPin(p: KeyPair) {
  console.log(
    [
      'pin it      for servers that check your approvals (SPEC-approval §2):',
      ...pinRecipe(p.public).map((l) => `              ${l}`),
    ].join('\n'),
  );
}

/** Grant the agent a safe default policy: low risk, ≤ 25 USD each, ≤ 100 USD total, 30 days. */
async function installDefaultPolicy(p: KeyPair, a: KeyPair) {
  const caveats: Caveat[] = [
    { risk: 'low' },
    { each: { of: 'spend', max: 2500, scale: 2, unit: 'USD' } },
    { total: { of: 'spend', max: 10000, scale: 2, unit: 'USD' } },
    { exp: unixNow() + 30 * 86400 },
  ];
  const token = await issueGrant({ principal: p, to: a.public, caveats });

  saveGrant(token, 'grants', (await inspectGrant(token)).id.slice(0, 16));
  console.log(
    `policy      low-risk actions, ≤ 25.00 USD each, ≤ 100.00 USD total, 30 days. Anything else asks you. (change: ${self('grant …')})`,
  );
}
