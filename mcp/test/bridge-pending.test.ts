// The bridge's pending files (SPEC-bridge step 6; SPEC-approval §6, Short ids): a short id per
// code, `yea approve <id>` on one machine with nothing passed back, and the files' lifecycle.
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import {
  approveConsentCode,
  consentCode,
  decodeConsentCode,
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

/** This process, as the bridge's pending files name it. */
const HERE = { host: hostname(), pid: process.pid };

/** A bridge's pending file for `code`: the code, then this process as canonical JSON. */
const bridgeFile = (code: string) =>
  `${code}\n{"host":${JSON.stringify(HERE.host)},"pid":${HERE.pid}}\n`;

/** A process that has ended: its pid, for a file a bridge left behind. */
const endedPid = () => spawnSync(process.execPath, ['-e', '']).pid ?? 0;

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
    // Each file is the code, then this process: the bridge that holds its proposal.
    expect(pendingFiles(k)).toEqual(
      Object.fromEntries(codes.map((c) => [c.id, bridgeFile(c.code)])),
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

  it("at start-up, a bridge removes an ended bridge's files, and leaves a running one's", async () => {
    const k = await keys();
    // A running bridge: every client starts its own, with the same home.
    const { conn } = await bridged(k);
    const live = codesOf(await conn.call(BIG_ORDER, 'shop_order'));
    const c = decodeConsentCode(live[0].code);
    const pending = homePending(k.home);
    const code = (proposal: string) =>
      consentCode({ ...c, proposal }, c.detail, { agent: c.agent as string });
    const now = unixNow();
    const ended = pending.put(code('p_ended'), now, {
      host: HERE.host,
      pid: endedPid(),
    });
    // Kept: a process on another host can't be checked from here, and a server names none.
    const elsewhere = pending.put(code('p_elsewhere'), now, {
      host: `not-${HERE.host}`,
      pid: endedPid(),
    });
    const server = pending.put(code('p_server'), now);

    await connect('2026', await bridgeIn(k, (await examples(k)).clients));

    expect(Object.keys(pendingFiles(k)).sort()).toEqual(
      [...live.map((l) => l.id), elsewhere, server].sort(),
    );
    expect(pendingFiles(k)).not.toHaveProperty(ended);

    // The running bridge's ids still work: approve one, and its next call commits.
    await approveHere(k, live[0].id ?? '');
    expect(textOf(await conn.call(BIG_ORDER, 'shop_order'))).toContain('✓');
  });
});
