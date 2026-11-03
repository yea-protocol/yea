// The bridge's pending files (SPEC-bridge step 6; SPEC-approval §6, Short ids): a short id per
// code, `yea approve <id>` on one machine with nothing passed back, and the files' lifecycle.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  approveConsentCode,
  consentCode,
  decodeConsentCode,
  keyPair,
  unixNow,
} from '@yea-protocol/sdk';
import { homePending, saveGrant } from '@yea-protocol/sdk/node';
import { describe, expect, it } from 'vitest';
import {
  BIG_ORDER,
  bridged,
  bridgeIn,
  examples,
  type Keys,
  keys,
  proposalsOf,
} from './bridge-helpers.js';
import { connect, textOf } from './helpers.js';

/** The structured codes of a result, with their ids. */
const codesOf = (r: { structuredContent?: unknown }) =>
  proposalsOf(r).codes as { proposal: string; code: string; id?: string }[];

/** The pending files in the test home, by name. */
function pendingFiles(k: Keys): Record<string, string> {
  const dir = join(k.home, 'pending');

  try {
    return Object.fromEntries(
      readdirSync(dir).map((f) => [f, readFileSync(join(dir, f), 'utf8')]),
    );
  } catch {
    return {};
  }
}

/** `yea approve <id>` on this machine: its agent key is the code's, so the consent is saved here. */
async function approveHere(k: Keys, id: string) {
  const code = homePending(k.home).read(id) ?? '';
  const r = await approveConsentCode({
    principal: k.principal,
    code,
    localAgent: k.agent.public,
    io: { print: () => undefined, confirm: async () => true },
    save: (token, hash) => saveGrant(token, 'consents', hash, k.home),
  });

  if (!r.ok || !r.saved) {
    throw new Error(r.ok ? 'not saved' : r.why);
  }
}

describe('the bridge’s pending files', () => {
  it('on one machine: yea approve <id>, nothing passed back, and the same call commits', async () => {
    const k = await keys();
    const { conn, shop } = await bridged(k);
    const first = await conn.call(BIG_ORDER, 'shop_order');
    const codes = codesOf(first);
    const agent = k.agent.public;

    expect(codes.length).toBeGreaterThan(1);
    expect(textOf(first)).toContain(
      [
        'Ask the user to run `yea approve <id>` in a terminal outside this chat, then call this tool again with the same arguments; on this machine nothing needs pasting back.',
        ...codes.map((c) => `  [${c.proposal}] yea approve ${c.id}`),
        `If their principal key is on another machine, they run \`yea approve <code> --to ${agent}\` there instead, then paste the printed consent back to you: pass it to \`yea_consent\`, and call this tool again.`,
        ...codes.map((c) => `  code for [${c.proposal}]: ${c.code}`),
      ].join('\n'),
    );
    expect(pendingFiles(k)).toEqual(
      Object.fromEntries(codes.map((c) => [c.id, `${c.code}\n`])),
    );

    // Called again before approval: the same ids, so the one passed on still works.
    const again = codesOf(await conn.call(BIG_ORDER, 'shop_order'));

    expect(again.map((c) => c.id)).toEqual(codes.map((c) => c.id));

    await approveHere(k, codes[1].id ?? '');

    const done = await conn.call(BIG_ORDER, 'shop_order');

    expect(textOf(done)).toContain('(express, by noon)');
    expect(shop.verbs('COMMIT')).toHaveLength(1);
    // Committed: the entry is gone, and its files with it.
    expect(pendingFiles(k)).toEqual({});
  });

  it('a code under 2 minutes from expiry loses its file, and so does an entry that drops', async () => {
    const k = await keys();
    let now = unixNow();
    const { conn } = await bridged(k, '2026', { options: { now: () => now } });
    const first = proposalsOf(await conn.call(BIG_ORDER, 'shop_order'));

    expect(Object.keys(pendingFiles(k))).toHaveLength(first.codes.length);

    now = first.proposals[0].expires - 119;
    await conn.call(BIG_ORDER, 'shop_order');

    // The old entry dropped; the fresh proposals arrive too close to expiry to get codes.
    expect(pendingFiles(k)).toEqual({});
  });

  it('at start-up, a bridge removes the files it wrote before, and leaves others alone', async () => {
    const k = await keys();
    const { conn } = await bridged(k);
    const [code] = codesOf(await conn.call(BIG_ORDER, 'shop_order'));
    const c = decodeConsentCode(code.code);
    const other = await keyPair();
    // Another agent's code at the same service: not this bridge's to remove.
    const foreign = consentCode({ ...c, proposal: 'p_theirs' }, c.detail, {
      agent: other.public,
    });
    const theirs = homePending(k.home).put(foreign, unixNow());

    const ex = await examples(k);

    await connect('2026', await bridgeIn(k, ex.clients));

    expect(Object.keys(pendingFiles(k))).toEqual([theirs]);
  });
});
