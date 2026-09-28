/**
 * The objective's shape: `serveStdio` with a factory the SDK may call more than once, and one
 * `yea()` context. The same job behaves the same on both eras.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  approve,
  connect,
  grantPolicy,
  type Kind,
  refundServer,
  textOf,
  world,
} from './helpers.js';

afterEach(() => {
  delete process.env.YEA_HOME;
});

const ch1 = { charge: 'ch_1' };

describe.each<Kind>(['stdio-2026', 'stdio-2025'])('serveStdio, %s', (kind) => {
  it('auto-runs within the policy, and undoes', async () => {
    const w = await world();

    await grantPolicy(w);

    const conn = await connect(kind, refundServer(w));
    const r = await conn.call(ch1);
    const { receipt } = r.structuredContent as { receipt: { id: string } };

    expect(w.applied).toEqual(['ch_1']);
    expect(
      (await conn.call({ receipt: receipt.id }, 'undo')).isError,
    ).toBeFalsy();
    expect(w.reverted).toEqual([ch1]);
  });

  it('asks outside the policy, and runs on the phrase', async () => {
    const w = await world();
    const conn = await connect(kind, refundServer(w));

    conn.answers.push({ action: 'accept', content: { confirm: 'ch_1' } });
    expect((await conn.call(ch1)).isError).toBeFalsy();
    expect(conn.elicited).toHaveLength(1);
    expect(w.applied).toEqual(['ch_1']);
  });

  it('a declined form leaves consent codes for later, through the same store', async () => {
    const w = await world();
    const conn = await connect(kind, refundServer(w));

    conn.answers.push({ action: 'decline' });
    expect(textOf(await conn.call(ch1))).toMatch(/not approved/);
    expect(w.applied).toEqual([]);

    // An approval from `yea approve` is honoured whatever the client can do.
    const preview = await conn.call({ ...ch1, preview: true });
    const { plans } = preview.structuredContent as {
      plans: { planHash: string }[];
    };

    expect(plans).toHaveLength(1);
    expect(await approve(w, await codeFor(w, kind))).toMatchObject({
      planHash: plans[0].planHash,
    });
    expect((await conn.call(ch1)).isError).toBeFalsy();
    expect(conn.elicited).toHaveLength(1);
  });
});

/** A consent code for ch_1, from a client that can't ask, on the same server and store. */
async function codeFor(w: Awaited<ReturnType<typeof world>>, kind: Kind) {
  const other = await connect(
    kind === 'stdio-2026' ? '2026-no-elicit' : '2025-no-elicit',
    refundServer(w),
  );
  const r = await other.call(ch1);

  return (r.structuredContent as { codes: { code: string }[] }).codes[0].code;
}
