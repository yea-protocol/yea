import {
  existsSync,
  mkdtempSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as P from '../src/index.js';
import { checkKeyFile, FileStore, readPinnedKey } from '../src/node.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'yea-approval-'));
const now = 1790000000;
const key = { block: 'B', of: 'emails' };

const receipt = (over: Partial<P.JobReceipt> = {}): P.JobReceipt => ({
  id: 'r_AAAAAAAAAAAA',
  proposal: 'H',
  capability: 'reschedule',
  summary: 'Move standup',
  at: now,
  effects: [],
  undo: { until: now + 60 },
  tool: 'reschedule',
  input: { event: 'e1' },
  planHash: 'H',
  sub: '',
  result: { moved: true },
  ...over,
});

describe.each([
  ['MemoryStore', () => new P.MemoryStore()],
  ['FileStore', () => new FileStore(tmp())],
])('%s', (_name, make) => {
  it('consumes an id once, even under concurrent calls', async () => {
    const s = make();
    const got = await Promise.all(
      Array.from({ length: 10 }, () => s.consumeOnce('n_1', now + 600)),
    );

    expect(got.filter(Boolean)).toHaveLength(1);
  });

  it('never reserves past a limit under concurrent calls, and releases on failure', async () => {
    const s = make();
    const got = await Promise.all(
      Array.from({ length: 10 }, () => s.reserve(key, 1n, 5n)),
    );
    const made = got.filter((r): r is P.Reservation => r !== null);

    expect(made).toHaveLength(5);
    await s.release(made[0]);
    await s.settle(made[1]);
    expect(await s.used(key)).toBe(4n);
    expect(await s.reserve(key, 1n, 5n)).not.toBeNull();
  });

  it('keeps receipts and consents', async () => {
    const s = make();

    await s.putReceipt(receipt());
    await s.putConsent('H', 'pg1.x');
    expect((await s.getReceipt('r_AAAAAAAAAAAA'))?.result).toEqual({
      moved: true,
    });
    expect(await s.getConsent('H')).toBe('pg1.x');
    expect(await s.getConsent('other')).toBeNull();
  });
});

describe('undo (SPEC-approval §7)', () => {
  const setup = async () => {
    const store = new P.MemoryStore();

    await store.putReceipt(receipt());

    return store;
  };

  it('undoes once, within the window, for the same principal', async () => {
    const store = await setup();
    const seen: unknown[] = [];
    const revert = (r: P.JobReceipt) => {
      seen.push(r.input);
    };

    expect(
      (await P.undoJob(store, { id: 'r_AAAAAAAAAAAA', sub: '', now, revert }))
        .kind,
    ).toBe('undone');
    expect(seen).toEqual([{ event: 'e1' }]);
    expect(
      await P.undoJob(store, { id: 'r_AAAAAAAAAAAA', sub: '', now, revert }),
    ).toEqual({
      kind: 'refused',
      why: 'this job was already undone',
    });
  });

  it('refuses another principal, a closed window and an irreversible job', async () => {
    const store = await setup();
    const revert = () => null;

    await store.putReceipt(receipt({ id: 'r_BBBBBBBBBBBB', undo: null }));

    expect(
      await P.undoJob(store, {
        id: 'r_AAAAAAAAAAAA',
        sub: 'someone-else',
        now,
        revert,
      }),
    ).toEqual({ kind: 'refused', why: 'no such receipt' });
    expect(
      await P.undoJob(store, {
        id: 'r_AAAAAAAAAAAA',
        sub: '',
        now: now + 60,
        revert,
      }),
    ).toEqual({ kind: 'refused', why: 'the undo window has closed' });
    expect(
      await P.undoJob(store, { id: 'r_BBBBBBBBBBBB', sub: '', now, revert }),
    ).toEqual({ kind: 'refused', why: 'this job can never be undone' });
  });

  it('a failed revert can be tried again', async () => {
    const store = await setup();
    let fail = true;
    const revert = () => {
      if (fail) {
        throw new Error('api down');
      }
    };

    await expect(
      P.undoJob(store, { id: 'r_AAAAAAAAAAAA', sub: '', now, revert }),
    ).rejects.toThrow('api down');
    fail = false;
    expect(
      (await P.undoJob(store, { id: 'r_AAAAAAAAAAAA', sub: '', now, revert }))
        .kind,
    ).toBe('undone');
  });
});

describe('approval security', () => {
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
        await P.undoJob(store, { id, sub: '', now, revert: () => null }),
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
    ).rejects.toThrow('non-integer');
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
    expect(existsSync(join(tmpdir(), 'never'))).toBe(false);
  });
});
