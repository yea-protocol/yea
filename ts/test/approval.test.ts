import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as P from '../src/index.js';
import { FileStore } from '../src/node.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'yea-approval-'));
const now = 1790000000;
const key = { block: 'B', of: 'emails' };

const receipt = (over: Partial<P.JobReceipt> = {}): P.JobReceipt => ({
  id: 'r_AAAAAAAAAAAA',
  service: 'S',
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
      (
        await P.undoJob(store, {
          service: 'S',
          id: 'r_AAAAAAAAAAAA',
          sub: '',
          now,
          revert,
        })
      ).kind,
    ).toBe('undone');
    expect(seen).toEqual([{ event: 'e1' }]);
    expect(
      await P.undoJob(store, {
        service: 'S',
        id: 'r_AAAAAAAAAAAA',
        sub: '',
        now,
        revert,
      }),
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
        service: 'S',
        id: 'r_AAAAAAAAAAAA',
        sub: 'someone-else',
        now,
        revert,
      }),
    ).toEqual({ kind: 'refused', why: 'no such receipt' });
    expect(
      await P.undoJob(store, {
        service: 'S',
        id: 'r_AAAAAAAAAAAA',
        sub: '',
        now: now + 61,
        revert,
      }),
    ).toEqual({ kind: 'refused', why: 'the undo window has closed' });
    expect(
      await P.undoJob(store, {
        service: 'S',
        id: 'r_BBBBBBBBBBBB',
        sub: '',
        now,
        revert,
      }),
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
      P.undoJob(store, {
        service: 'S',
        id: 'r_AAAAAAAAAAAA',
        sub: '',
        now,
        revert,
      }),
    ).rejects.toThrow('api down');
    fail = false;
    expect(
      (
        await P.undoJob(store, {
          service: 'S',
          id: 'r_AAAAAAAAAAAA',
          sub: '',
          now,
          revert,
        })
      ).kind,
    ).toBe('undone');
  });
});

describe('assertIntegers (SPEC-approval §1)', () => {
  it('passes integer-only inputs and names the first other number', () => {
    expect(() =>
      P.assertIntegers({ n: 3, deep: [{ ok: -2 }], s: '1.5' }),
    ).not.toThrow();
    expect(() => P.assertIntegers({ deep: [{ x: 1.5 }] })).toThrow(
      'input.deep.0.x is 1.5: job inputs can only hold safe integers',
    );
  });
});
