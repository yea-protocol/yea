// Drives `yea test-drive` against a mock Messages API, through the bridge: the loop, the
// adapter, auto-commit within policy and the person's approval all run for real; only the
// model and the person's answers are scripted.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { testDrive } from '../src/test-drive.js';
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
});
