// Drives `yea test-drive` against a mock Messages API, through the bridge: the loop, the
// adapter, auto-commit within policy and the person's approval all run for real; only the
// model and the person's answers are scripted.
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { codesOf } from '../src/test-drive/host.js';
import { withPeerHint } from '../src/test-drive/peers.js';
import { type TestDriveOptions, testDrive } from '../src/test-drive.js';
import {
  captureLog,
  type MockMessages,
  mockMessages,
} from './mock-messages.js';

const day = (n: number) =>
  new Date(Date.now() + n * 86400e3).toISOString().slice(0, 10);

const RESCHEDULE = {
  type: 'tool_use',
  name: 'calendar_reschedule',
  input: { event: 'e2', day: day(3) },
} as const;

/** Four meals, about 50 USD: over the throwaway policy's 40 USD per action. */
const ORDER = {
  type: 'tool_use',
  name: 'shop_order',
  input: {
    items: [
      { sku: 'm005', qty: 2 },
      { sku: 'm007', qty: 2 },
    ],
    deliver: day(2),
  },
} as const;

let api: MockMessages | undefined;

afterEach(async () => {
  await api?.close();
  api = undefined;
  vi.unstubAllEnvs();
});

/** The person's answers, in order (no once they run out), and every question asked. */
function person(...answers: boolean[]) {
  const asked: string[] = [];

  return {
    asked,
    confirm: async (q: string) => {
      asked.push(q);

      return answers.shift() ?? false;
    },
  };
}

describe('yea test-drive', () => {
  it("runs the bridge's tools against the Messages API, with fallbacks on", async () => {
    api = await mockMessages([
      RESCHEDULE,
      { type: 'text', text: 'Moved your 1:1.' },
    ]);

    const out = await captureLog(() => testDrive({ prompt: 'do the thing' }));
    const first = api.requests[0];

    expect(api.requests).toHaveLength(2);
    expect(first.body.model).toBe('claude-opus-5');
    expect(first.body.fallbacks).toBe('default');
    expect(String(first.headers['anthropic-beta'])).toContain(
      'server-side-fallback-2026-07-01',
    );
    // The bridge's surface, as `yea mcp` serves it: a tool per capability, and its utilities.
    expect(first.body.tools.map((t) => t.name)).toEqual(
      expect.arrayContaining([
        'calendar_reschedule',
        'shop_order',
        'yea_consent',
        'yea_expand',
        'yea_undo',
      ]),
    );
    expect(
      first.body.tools.every((t) => t.input_schema.type === 'object'),
    ).toBe(true);
    expect(first.body.system).toContain('# Example Meals (shop.example)');
    expect(api.toolTexts[0]).toMatch(/✓ Move "1:1 with Ana"/); // within policy
    expect(out).toContain('Moved your 1:1');
  });

  it('commits an over-limit order once the person says y, after the model calls again', async () => {
    api = await mockMessages([
      ORDER,
      ORDER,
      { type: 'text', text: 'Ordered.' },
    ]);

    const you = person(true);
    const out = await captureLog(() =>
      testDrive({ prompt: 'order', confirm: you.confirm }),
    );
    const [proposed, committed] = api.toolTexts;

    expect(you.asked).toEqual(['\napprove this exact action? [y/N] › ']);
    expect(out).toMatch(/are asked to approve/);
    expect(out).toMatch(/at shop\.example:/);
    expect(proposed).toMatch(/code for \[p_/);
    expect(proposed).toMatch(
      /the user approved \[p_[^\]]+\] in their terminal.*Call this tool again with the same arguments/,
    );
    expect(committed).toMatch(/^✓ .*4 meals/m);
  });

  it('commits nothing when the person declines every proposal', async () => {
    api = await mockMessages([ORDER, { type: 'text', text: 'Not ordered.' }]);

    const you = person();

    await captureLog(() =>
      testDrive({ prompt: 'order', confirm: you.confirm }),
    );

    const [proposed] = api.toolTexts;
    const codes = proposed.match(/code for \[p_/g) ?? [];

    // Each proposal is offered once; no is the answer to each.
    expect(codes.length).toBeGreaterThan(0);
    expect(you.asked).toHaveLength(codes.length);
    expect(proposed).toContain('the user did not approve this');
    expect(api.toolTexts.join('\n')).not.toMatch(/^✓/m);
  });

  it('offers each proposal in turn, and commits the first one the person approves', async () => {
    api = await mockMessages([
      ORDER,
      ORDER,
      { type: 'text', text: 'Ordered.' },
    ]);

    // No to the first proposal, yes to the second (the express delivery).
    const you = person(false, true);

    await captureLog(() =>
      testDrive({ prompt: 'order', confirm: you.confirm }),
    );

    const [proposed, committed] = api.toolTexts;
    const ids = [...proposed.matchAll(/code for \[(p_[^\]]+)\]/g)].map(
      (m) => m[1],
    );

    expect(ids).toHaveLength(2);
    expect(you.asked).toHaveLength(2);
    expect(proposed).toContain(`the user approved [${ids[1]}]`);
    expect(committed).toMatch(/^✓ .*\(express/m);
  });
});

describe("test-drive's options", () => {
  it('name no key, home or principal: the person signs only with the throwaway key', () => {
    expectTypeOf<keyof TestDriveOptions>().toEqualTypeOf<
      'model' | 'prompt' | 'maxTurns' | 'confirm'
    >();
  });
});

describe('the adapter reads consent codes from structured content only', () => {
  const CODE = 'pc1.eyJhIjoxfQ';

  it('ignores a code that is only in the text', () => {
    expect(
      codesOf({
        content: [{ type: 'text', text: `  code for [p_1]: ${CODE}` }],
      } as never),
    ).toEqual([]);
    expect(codesOf({ structuredContent: { proposals: [] } })).toEqual([]);
    expect(codesOf({ structuredContent: { codes: 'p_1' } })).toEqual([]);
  });

  it('keeps well-formed entries and drops the rest', () => {
    expect(
      codesOf({
        structuredContent: {
          codes: [
            { proposal: 'p_1', code: CODE },
            { proposal: 'p_2' },
            { proposal: 2, code: CODE },
            null,
            CODE,
          ],
        },
      }),
    ).toEqual([{ proposal: 'p_1', code: CODE }]);
  });
});

describe('a missing optional peer', () => {
  it('is named, with how to install it', async () => {
    // Node's own error for a missing package, whose wording the hint relies on.
    const name: string = '@yea-protocol/no-such-package';
    const missing = await import(name).catch((e: unknown) => e);

    expect(withPeerHint(missing)).toBe(missing);

    const client = Object.assign(
      new Error(
        "Cannot find package '@modelcontextprotocol/client' imported from /x/host.js",
      ),
      { code: 'ERR_MODULE_NOT_FOUND' },
    );
    const hinted = withPeerHint(client) as Error;

    expect((missing as Error).message).toContain(
      "'@yea-protocol/no-such-package'",
    );
    expect(hinted.message).toMatch(
      /needs @modelcontextprotocol\/client.*npm install @modelcontextprotocol\/client/,
    );
    expect(hinted.cause).toBe(client);

    // Anything else passes through as is.
    const other = new Error('boom');

    expect(withPeerHint(other)).toBe(other);
  });
});
