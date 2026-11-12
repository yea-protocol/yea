import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { assertIntegers } from '../src/approval.js';
import * as P from '../src/index.js';
import { FileStore } from '../src/node.js';

// A filesystem without hard links, for the store id (SPEC-approval §8): with `linkFails` set,
// link() fails with that code. `renamed` records each rename's target, and whether a lock file
// for it (`<target>.lock`) existed then. `afterCreate` runs after each O_EXCL create, as a lock
// is taken. Null leaves fs alone.
const fsHook = vi.hoisted(() => ({
  linkFails: null as string | null,
  renamed: [] as { to: string; locked: boolean }[],
  afterCreate: null as ((path: string) => void) | null,
}));

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  const linkSync = (...args: Parameters<typeof real.linkSync>) => {
    if (fsHook.linkFails) {
      throw Object.assign(new Error(`${fsHook.linkFails}: no hard links`), {
        code: fsHook.linkFails,
      });
    }

    return real.linkSync(...args);
  };
  const renameSync = (...args: Parameters<typeof real.renameSync>) => {
    const to = String(args[1]);

    fsHook.renamed.push({ to, locked: real.existsSync(`${to}.lock`) });
    real.renameSync(...args);
  };
  const writeFileSync = (...args: Parameters<typeof real.writeFileSync>) => {
    real.writeFileSync(...args);

    const o = args[2];

    if (typeof o === 'object' && o?.flag === 'wx') {
      fsHook.afterCreate?.(String(args[0]));
    }
  };

  return {
    ...real,
    default: { ...real, linkSync, renameSync, writeFileSync },
    linkSync,
    renameSync,
    writeFileSync,
  };
});

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
  it('has a store id, the same every time, and another store has another (SPEC-approval §8)', async () => {
    const s = make();
    const id = await s.storeId();

    expect(P.isStoreId(id)).toBe(true);
    expect(await s.storeId()).toBe(id);
    expect(await make().storeId()).not.toBe(id);
  });

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
      assertIntegers({ n: 3, deep: [{ ok: -2 }], s: '1.5' }),
    ).not.toThrow();
    expect(() => assertIntegers({ deep: [{ x: 1.5 }] })).toThrow(
      'input.deep.0.x is 1.5: job inputs can only hold safe integers',
    );
  });
});

describe('a FileStore id (SPEC-approval §8)', () => {
  it('is made once, whole, in <root>/id, and every store on that root reads it', async () => {
    const root = tmp();
    const ids = await Promise.all(
      Array.from({ length: 8 }, () => new FileStore(root).storeId()),
    );

    expect(new Set(ids).size).toBe(1);
    expect(readFileSync(join(root, 'id'), 'utf8')).toBe(ids[0]);
    expect(statSync(join(root, 'id')).mode & 0o777).toBe(0o600);
    expect(readdirSync(root)).toEqual(['id']);
  });

  it.each(['ENOTSUP', 'EPERM', 'ENOSYS'])(
    'where link fails with %s (no hard links), is made once under <root>/id.lock, across racing stores',
    async (code) => {
      const root = tmp();

      fsHook.linkFails = code;
      fsHook.renamed = [];

      try {
        const ids = await Promise.all(
          Array.from({ length: 8 }, () => new FileStore(root).storeId()),
        );

        expect(new Set(ids).size).toBe(1);
        expect(P.isStoreId(ids[0])).toBe(true);
        expect(readFileSync(join(root, 'id'), 'utf8')).toBe(ids[0]);
        expect(statSync(join(root, 'id')).mode & 0o777).toBe(0o600);
        // One rename made it, while its maker held <root>/id.lock; the lock and every temp
        // file are gone.
        expect(fsHook.renamed).toEqual([
          { to: join(root, 'id'), locked: true },
        ]);
        expect(readdirSync(root)).toEqual(['id']);
      } finally {
        fsHook.linkFails = null;
      }
    },
  );

  it("is a store error, and makes no id, when its lock is taken over while it holds it; the other's lock stays", async () => {
    const root = tmp();
    const lock = join(root, 'id.lock');

    fsHook.linkFails = 'ENOTSUP';
    // Once it has the lock, another maker breaks it as stale and takes it: a holder paused 30 s.
    fsHook.afterCreate = (path) => {
      if (path === lock) {
        writeFileSync(lock, 'theirs');
      }
    };

    try {
      await expect(new FileStore(root).storeId()).rejects.toThrow(
        `lost the store id's lock (${lock}); no id was made`,
      );
      expect(existsSync(join(root, 'id'))).toBe(false);
      expect(readFileSync(lock, 'utf8')).toBe('theirs');
      expect(readdirSync(root)).toEqual(['id.lock']);
    } finally {
      fsHook.linkFails = null;
      fsHook.afterCreate = null;
    }
  });

  it('is a store error naming the file when making it fails any other way, and none is made', async () => {
    const root = tmp();
    const path = join(root, 'id');

    fsHook.linkFails = 'EACCES';

    try {
      await expect(new FileStore(root).storeId()).rejects.toThrow(
        `can't make the store id at ${path}: EACCES`,
      );
      expect(readdirSync(root)).toEqual([]);
    } finally {
      fsHook.linkFails = null;
    }
  });

  it('is a store error when the file holds anything else, and nothing is made over it', async () => {
    const root = tmp();

    writeFileSync(join(root, 'id'), 'not an id');
    await expect(new FileStore(root).storeId()).rejects.toThrow(
      "doesn't hold a store id",
    );
    expect(readFileSync(join(root, 'id'), 'utf8')).toBe('not an id');
  });

  it("is a store error naming the file when it can't be read", async () => {
    const root = tmp();
    const path = join(root, 'id');

    mkdirSync(path);
    await expect(new FileStore(root).storeId()).rejects.toThrow(
      `can't read the store id at ${path}: not a regular file`,
    );
  });

  it('a MemoryStore takes a fixed id only if it is one', () => {
    expect(() => new P.MemoryStore({ id: 'short' })).toThrow('not a store id');
  });
});

describe('isMemoryStore', () => {
  it('reads the brand, not the class, so another SDK copy’s MemoryStore still counts', () => {
    expect(P.isMemoryStore(new P.MemoryStore())).toBe(true);
    expect(P.isMemoryStore({ yeaStore: 'memory' })).toBe(true);
    expect(P.isMemoryStore(new FileStore(tmp()))).toBe(false);
    expect(P.isMemoryStore(null)).toBe(false);
  });
});
