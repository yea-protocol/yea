/**
 * The approval core's security list, from the MCP side (SPEC-mcp-ts, Testing). The core's own
 * regression tests are in ts/test/security.test.ts.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createRequestStateCodec,
  McpServer,
} from '@modelcontextprotocol/server';
import { MemoryStore, quantity } from '@yea-protocol/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import {
  approve,
  connect,
  grantPolicy,
  ledgerKeyOf,
  refundJob,
  refundServer,
  textOf,
  world,
} from './helpers.js';

afterEach(() => {
  delete process.env.YEA_HOME;
});

const ch1 = { charge: 'ch_1' };

/** Consent codes from a call a client can't answer. */
async function codesFor(conn: Awaited<ReturnType<typeof connect>>, args = ch1) {
  const r = await conn.call(args);

  expect(r.isError).toBe(true);

  return (
    r.structuredContent as { codes: { planHash: string; code: string }[] }
  ).codes;
}

describe('MCP-side approval security', () => {
  it('[M1] a denied tool never runs, even with a stored consent', async () => {
    const w = await world();
    const conn = await connect('2025-no-elicit', refundServer(w));
    const [c] = await codesFor(conn);

    await approve(w, c.code);
    // The person then denies the tool in ~/.yea/policy.json.
    writeFileSync(
      join(w.home, 'policy.json'),
      JSON.stringify({ deny: ['refund'] }),
    );

    const r = await conn.call(ch1);

    expect(textOf(r)).toMatch(/your policy never allows refund/);
    expect(w.applied).toEqual([]);
  });

  it('[M2] a high plan is never offered in the form, and can’t be chosen anyway', async () => {
    const w = await world();
    const conn = await connect(
      '2026',
      refundServer(w, {
        plan: ({ charge }) =>
          (['low', 'high'] as const).map((risk) => ({
            summary: `Refund ${risk} ${charge}`,
            effects: [],
            risk,
            apply: () => {
              w.applied.push(risk);
            },
          })),
        confirmWith: () => 'approve',
      }),
    );
    const first = await conn.raw({ name: 'refund', arguments: ch1 });
    const elicit = (
      first.inputRequests as { yea: { params: Record<string, unknown> } }
    ).yea.params;

    expect(elicit.requestedSchema).toEqual({
      type: 'object',
      properties: { confirm: expect.any(Object) },
      required: ['confirm'],
    });
    expect(elicit.message).toMatch(
      /Not offered here \(approve outside the chat\): \[2\]/,
    );

    const preview = await conn.call({ ...ch1, preview: true });
    const high = (
      preview.structuredContent as { plans: { planHash: string }[] }
    ).plans[1];
    const r = await conn.raw({
      name: 'refund',
      arguments: ch1,
      requestState: first.requestState,
      inputResponses: {
        yea: {
          action: 'accept',
          content: { plan: high.planHash, confirm: 'approve' },
        },
      },
    });

    expect(textOf(r)).toMatch(/that plan was not offered/);
    expect(w.applied).toEqual([]);
  });

  it('[M3] an irreversible plan never auto-runs, whatever the policy says', async () => {
    const w = await world();

    await grantPolicy(w, [{ can: ['refund'] }, { risk: 'high' }]);

    const conn = await connect(
      '2025-no-elicit',
      refundServer(w, { revert: undefined }),
    );
    const r = await conn.call(ch1);

    expect(textOf(r)).toMatch(/refund can't be undone/);
    expect(w.applied).toEqual([]);
  });

  it('[M4] a consent for one plan never runs another', async () => {
    const w = await world();
    const conn = await connect('2025-no-elicit', refundServer(w));
    const [one] = await codesFor(conn, ch1);
    const [two] = await codesFor(conn, { charge: 'ch_2' });

    await approve(w, one.code);
    expect((await conn.call({ charge: 'ch_2' })).isError).toBe(true);

    // Nor when it is stored under the other plan's hash.
    await w.store.putConsent(
      two.planHash,
      (await w.store.getConsent(one.planHash)) ?? '',
    );
    expect((await conn.call({ charge: 'ch_2' })).isError).toBe(true);
    expect(w.applied).toEqual([]);

    // It still runs its own plan, once.
    expect((await conn.call(ch1)).isError).toBeFalsy();
    expect(w.applied).toEqual(['ch_1']);
  });

  it('[M5] a stored copy of the policy grant never counts as a consent', async () => {
    const w = await world();
    const token = await grantPolicy(w, [{ can: ['refund'] }, { risk: 'high' }]);
    const conn = await connect(
      '2025-no-elicit',
      refundServer(w, { revert: undefined }),
    );
    const [c] = await codesFor(conn);

    await w.store.putConsent(c.planHash, token);
    expect((await conn.call(ch1)).isError).toBe(true);
    expect(w.applied).toEqual([]);
  });

  it('[M6] a requestState the codec didn’t verify is refused', async () => {
    const w = await world();
    const conn = await connect('2026', refundServer(w));
    const first = await conn.raw({ name: 'refund', arguments: ch1 });
    const state = String(first.requestState);
    const forged = await createRequestStateCodec<unknown>({
      key: 'f'.repeat(32),
      bind: (ctx) => `${ctx.mcpReq.method}\0`,
    }).mint({ yea: { v: 1 } }, { mcpReq: { method: 'tools/call' } } as never);
    const answer = { yea: { action: 'accept', content: { confirm: 'ch_1' } } };

    for (const requestState of [
      `${state.slice(0, -2)}xx`,
      forged,
      'not-a-state',
    ]) {
      await expect(
        conn.raw({
          name: 'refund',
          arguments: ch1,
          requestState,
          inputResponses: answer,
        }),
      ).rejects.toThrow(/Invalid or expired requestState/);
    }

    expect(w.applied).toEqual([]);
  });

  it('[M6] without the codec installed, a raw requestState is refused by the job', async () => {
    const w = await world();
    const conn = await connect('2025', () => {
      const server = new McpServer({ name: 'b', version: '1' }); // no serverOptions()

      w.approvals.job(server, 'refund', refundJob(w));

      return server;
    });
    const r = await conn.raw({
      name: 'refund',
      arguments: ch1,
      requestState: 'v1.anything',
      inputResponses: {
        yea: { action: 'accept', content: { confirm: 'ch_1' } },
      },
    });

    expect(textOf(r)).toMatch(/requestState was not verified/);
    expect(w.applied).toEqual([]);
  });

  it('[M7] a state for other input, or from another tool’s state, runs nothing', async () => {
    const w = await world();
    const conn = await connect('2026', refundServer(w));
    const first = await conn.raw({ name: 'refund', arguments: ch1 });
    const r = await conn.raw({
      name: 'refund',
      arguments: { charge: 'ch_2' },
      requestState: first.requestState,
      inputResponses: {
        yea: { action: 'accept', content: { confirm: 'ch_2' } },
      },
    });

    expect(textOf(r)).toMatch(
      /invalid, expired, already used, or for another call/,
    );
    expect(w.applied).toEqual([]);
  });

  it('[M8] explicit approval doesn’t count against the policy’s totals', async () => {
    const w = await world();

    const token = await grantPolicy(w, [
      { can: ['refund'] },
      { total: { of: 'emails', max: 1 } },
    ]);

    const conn = await connect(
      '2025',
      refundServer(w, {
        plan: ({ charge }) => [
          {
            summary: `Refund ${charge}`,
            effects: [],
            uses: { emails: quantity(5) },
            undoWindow: 60,
            apply: () => {
              w.applied.push(charge);
            },
          },
        ],
      }),
    );

    conn.answers.push({ action: 'accept', content: { confirm: 'ch_1' } });
    expect((await conn.call(ch1)).isError).toBeFalsy();
    expect(conn.elicited[0].message).toMatch(/emails would pass/);
    expect(await w.store.used(await ledgerKeyOf(token))).toBe(0n);
  });
});

describe('requestState that isn’t this call’s', () => {
  /** A codec an author shares between their own tools and yea({ codec }). */
  const sharedCodec = (bind: (ctx: { mcpReq: { method: string } }) => string) =>
    createRequestStateCodec<unknown>({ key: new Uint8Array(32).fill(3), bind });

  it('[M9] a verified state without our yea key (another tool’s, on a shared codec) is refused', async () => {
    const codec = sharedCodec((ctx) => `${ctx.mcpReq.method}\0`);
    const w = await world({ codec });
    const conn = await connect('2026', refundServer(w));
    const theirs = await codec.mint({ inner: 'step-2' }, {
      mcpReq: { method: 'tools/call' },
    } as never);
    const r = await conn.raw({
      name: 'refund',
      arguments: ch1,
      requestState: theirs,
      inputResponses: {
        yea: { action: 'accept', content: { confirm: 'ch_1' } },
      },
    });

    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/requestState belongs to something else/);
    expect(w.applied).toEqual([]);
  });

  it('[M7] a state from another job on the same server runs nothing there', async () => {
    const w = await world();
    const conn = await connect('2026', () => {
      const server = refundServer(w)();

      w.approvals.job(server, 'refund_other', refundJob(w));

      return server;
    });
    const first = await conn.raw({ name: 'refund', arguments: ch1 });
    const r = await conn.raw({
      name: 'refund_other',
      arguments: ch1,
      requestState: first.requestState,
      inputResponses: {
        yea: { action: 'accept', content: { confirm: 'ch_1' } },
      },
    });

    expect(textOf(r)).toMatch(
      /invalid, expired, already used, or for another call/,
    );
    expect(w.applied).toEqual([]);
  });

  /** An HTTP server whose caller is whoever `who` says. */
  async function httpAs(over: Record<string, unknown> = {}) {
    const who = { sub: 'ana' };
    const w = await world({
      transport: 'http',
      store: new MemoryStore(),
      singleProcess: true,
      sub: () => who.sub,
      ...over,
    });
    const conn = await connect('2026', refundServer(w));
    const first = await conn.raw({ name: 'refund', arguments: ch1 });

    who.sub = 'ben';

    const replay = () =>
      conn.raw({
        name: 'refund',
        arguments: ch1,
        requestState: first.requestState,
        inputResponses: {
          yea: { action: 'accept', content: { confirm: 'ch_1' } },
        },
      });

    return { w, replay };
  }

  it('[M10] an HTTP state minted for one sub, replayed by another, fails the codec’s bind', async () => {
    const { w, replay } = await httpAs();

    await expect(replay()).rejects.toThrow(/Invalid or expired requestState/);
    expect(w.applied).toEqual([]);
  });

  it('[M10] with an author’s codec that doesn’t bind sub, checkState still refuses it', async () => {
    const { w, replay } = await httpAs({
      codec: sharedCodec((ctx) => ctx.mcpReq.method),
    });
    const r = await replay();

    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(
      /invalid, expired, already used, or for another call/,
    );
    expect(w.applied).toEqual([]);
  });
});

describe('a policy file that can not be read', () => {
  it('refuses job calls instead of treating deny as empty', async () => {
    const w = await world();

    await grantPolicy(w);
    writeFileSync(join(w.home, 'policy.json'), 'not json');

    const conn = await connect('2026', refundServer(w));
    const r = await conn.call(ch1);

    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/policy.json is not valid JSON/);
    expect(w.applied).toEqual([]);
  });
});
