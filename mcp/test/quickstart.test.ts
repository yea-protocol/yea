/**
 * The guide's example (examples/mcp-quickstart.ts, site/guide/mcp-typescript.md) does what the
 * guide says, step by step: the guarded tool asks, the job undoes, a policy lets only the
 * undoable job run on its own, and a client that can't ask gets consent codes.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from '../../examples/mcp-quickstart.js';
import {
  approve,
  connect,
  grantPolicy,
  type Kind,
  textOf,
  tmp,
  type World,
  world,
} from './helpers.js';

afterEach(() => {
  delete process.env.YEA_HOME;
});

/** A folder with docs/report.pdf in it, and the example's server. */
function files(w: Pick<World, 'approvals'>) {
  const root = tmp();
  const report = join(root, 'docs', 'report.pdf');

  mkdirSync(join(root, 'docs'));
  writeFileSync(report, 'q3');

  return {
    root,
    report,
    args: { path: report },
    factory: () => createServer(w.approvals),
  };
}

describe.each<Kind>(['2026', '2025', 'stdio-2026'])(
  'on a %s client',
  (kind) => {
    it('step 2: the guarded tool shows its plan, and runs once the name is typed', async () => {
      const w = await world({ name: 'files' });
      const f = files(w);
      const conn = await connect(kind, f.factory);

      conn.answers.push({ action: 'accept', content: { confirm: 'approve' } });
      conn.answers.push({
        action: 'accept',
        content: { confirm: 'report.pdf' },
      });

      const r = await conn.call(f.args, 'delete_file');

      expect(r.isError).toBeFalsy();
      expect(textOf(r)).toBe(`deleted ${f.report}`);
      expect(existsSync(f.report)).toBe(false);

      // The wrong phrase asked again; the file's name ran it.
      expect(conn.elicited).toHaveLength(2);
      expect(conn.elicited[0].message).toContain(`Delete ${f.report}`);
      expect(conn.elicited[0].message).toContain("delete_file can't be undone");
      expect(conn.elicited[0].requestedSchema).toMatchObject({
        properties: {
          confirm: { description: 'Type "report.pdf" to approve.' },
        },
      });
    });

    it('step 2: a declined form deletes nothing', async () => {
      const w = await world({ name: 'files' });
      const f = files(w);
      const conn = await connect(kind, f.factory);

      conn.answers.push({ action: 'decline' });
      expect(textOf(await conn.call(f.args, 'delete_file'))).toMatch(
        /not approved/,
      );
      expect(existsSync(f.report)).toBe(true);
    });

    it('step 4: the job moves the file to the trash, and undo puts it back', async () => {
      const w = await world({ name: 'files' });
      const f = files(w);
      const conn = await connect(kind, f.factory);

      conn.answers.push({ action: 'accept', content: { confirm: 'approve' } });

      const r = await conn.call(f.args, 'move_to_trash');
      const { receipt } = r.structuredContent as {
        receipt: { id: string; undo: { until: number } | null };
      };

      expect(r.isError).toBeFalsy();
      expect(receipt.undo).not.toBeNull();
      expect(existsSync(f.report)).toBe(false);

      const undone = await conn.call({ receipt: receipt.id }, 'undo');

      expect(undone.isError).toBeFalsy();
      expect(existsSync(f.report)).toBe(true);
    });
  },
);

describe('step 4: undo', () => {
  it("won't overwrite a file that took the trashed one's place", async () => {
    const w = await world({ name: 'files' });
    const f = files(w);
    const conn = await connect('2026', f.factory);

    conn.answers.push({ action: 'accept', content: { confirm: 'approve' } });

    const r = await conn.call(f.args, 'move_to_trash');
    const { receipt } = r.structuredContent as { receipt: { id: string } };

    writeFileSync(f.report, 'new');

    const undone = await conn.call({ receipt: receipt.id }, 'undo');

    expect(undone.isError).toBe(true);
    expect(textOf(undone)).toMatch(/nothing was undone/);
  });

  it('refuses a directory, which it could not put back', async () => {
    const w = await world({ name: 'files' });
    const f = files(w);
    const conn = await connect('2026', f.factory);
    const r = await conn.call({ path: join(f.root, 'docs') }, 'move_to_trash');

    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/is not a regular file; nothing was run/);
    expect(conn.elicited).toHaveLength(0);
    expect(existsSync(f.report)).toBe(true);
  });
});

describe('step 5: a signed policy', () => {
  it('lets the undoable job run on its own, and still asks before a delete', async () => {
    const w = await world({ name: 'files' });
    const f = files(w);

    // What `yea grant --to <id> --can move_to_trash --risk low` makes.
    await grantPolicy(w, [{ can: ['move_to_trash'] }, { risk: 'low' }]);

    const conn = await connect('2026', f.factory);
    const moved = await conn.call(f.args, 'move_to_trash');

    expect(moved.isError).toBeFalsy();
    expect(conn.elicited).toHaveLength(0);
    expect(existsSync(f.report)).toBe(false);

    writeFileSync(f.report, 'q3 again');
    conn.answers.push({ action: 'decline' });
    await conn.call(f.args, 'delete_file');
    expect(conn.elicited).toHaveLength(1);
    expect(existsSync(f.report)).toBe(true);
  });
});

describe.each<Kind>(['2026-no-elicit', '2025-no-elicit'])(
  'step 6: on a %s client',
  (kind) => {
    it('gets a consent code; after yea approve, the call runs', async () => {
      const w = await world({ name: 'files' });
      const f = files(w);
      const conn = await connect(kind, f.factory);
      const r = await conn.call(f.args, 'delete_file');
      const { codes } = r.structuredContent as { codes: { code: string }[] };

      expect(r.isError).toBe(true);
      expect(textOf(r)).toContain('yea approve <code>');
      expect(codes).toHaveLength(1);
      expect(codes[0].code).toMatch(/^pc1\./);
      expect(existsSync(f.report)).toBe(true);

      await approve(w, codes[0].code);
      expect((await conn.call(f.args, 'delete_file')).isError).toBeFalsy();
      expect(existsSync(f.report)).toBe(false);
    });

    it('without a pinned principal key, says why and gives no code', async () => {
      const w = await world({ name: 'files', principal: undefined });
      const f = files(w);
      const conn = await connect(kind, f.factory);
      const r = await conn.call(f.args, 'delete_file');

      expect(r.isError).toBe(true);
      expect(r.structuredContent).toMatchObject({ codes: [] });
      expect(textOf(r)).toContain(
        'No consent can be accepted: YEA_PRINCIPAL_PUB is not set.',
      );
      expect(existsSync(f.report)).toBe(true);
    });
  },
);
