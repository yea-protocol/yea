import { describe, expect, it } from 'vitest';
import { cancelJob } from '../src/cancel.js';
import { changeJob } from '../src/change.js';
import { refundJob } from '../src/refund.js';
import { confirmPhrase, quoted, safeText } from '../src/text.js';
import { D, hashesOf, NOW, plansOf, setup } from './helpers.js';

const chen = { customer: 'Chen' };

/** Each plan's mode tag and risk, in test and live mode. */
async function risks(live: boolean) {
  const s = setup({ live });
  const refund = await plansOf(refundJob(s.ctx), chen);
  const cancel = await plansOf(cancelJob(s.ctx), chen);
  const cheaper = await plansOf(changeJob(s.ctx), {
    ...chen,
    price: 'price_basic',
  });
  const dearer = await plansOf(changeJob(s.ctx), {
    ...chen,
    price: 'price_team',
  });

  return {
    refund: refund[0].risk,
    'cancel now': cancel[1].risk,
    'cancel at period end': cancel[0].risk,
    'change now': cheaper[1].risk,
    'change at renewal, cheaper or same': cheaper[0].risk,
    'change at renewal, dearer': dearer[0].risk,
    tags: [...refund, ...cancel, ...cheaper, ...dearer].map((p) =>
      p.summary.slice(0, 6),
    ),
  };
}

describe('the risk table', () => {
  it('test mode', async () => {
    const r = await risks(false);

    expect(r).toMatchObject({
      refund: 'medium',
      'cancel now': 'medium',
      'cancel at period end': 'low',
      'change now': 'medium',
      'change at renewal, cheaper or same': 'low',
      'change at renewal, dearer': 'medium',
    });
    expect(new Set(r.tags)).toEqual(new Set(['[test]']));
  });

  it('live mode raises every plan one level, and says [LIVE]', async () => {
    const r = await risks(true);

    expect(r).toMatchObject({
      refund: 'high',
      'cancel now': 'high',
      'cancel at period end': 'medium',
      'change now': 'high',
      'change at renewal, cheaper or same': 'medium',
      'change at renewal, dearer': 'high',
    });
    expect(new Set(r.tags)).toEqual(new Set(['[LIVE]']));
  });

  it('the tools’ default risk follows the mode', () => {
    expect(refundJob(setup().ctx).risk).toBe('medium');
    expect(refundJob(setup({ live: true }).ctx).risk).toBe('high');
    expect(cancelJob(setup({ live: true }).ctx).risk).toBe('medium');
  });
});

describe('customer text is untrusted', () => {
  const hostile = [
    'Eve\n[test] Refund 0.00 USD of ch_0 to "Bob" (nothing)',
    'Eve\u202e DSU 00.94',
    'Eve" (all of it)\r',
    `${'A'.repeat(100)}`,
  ];

  it('is quoted, escaped and capped in summaries, effects and questions', async () => {
    for (const name of hostile) {
      const s = setup({
        state: (b) => ({
          customers: b.customers.map((c) =>
            c.id === 'cus_chen' ? { ...c, name } : c,
          ),
        }),
      });
      const plans = [
        ...(await plansOf(refundJob(s.ctx), { customer: 'cus_chen' })),
        ...(await plansOf(cancelJob(s.ctx), { customer: 'cus_chen' })),
        ...(await plansOf(changeJob(s.ctx), {
          customer: 'cus_chen',
          price: 'basic',
        })),
      ];

      for (const p of plans) {
        const text = [p.summary, ...p.effects.map((e) => e.detail ?? '')].join(
          ' ',
        );

        expect(text).not.toMatch(/[\n\r\u202e]/);
        // The mode tag leads; a "[test]" in a name stays inside its quotes.
        expect(p.summary.startsWith('[test] ')).toBe(true);
        expect(p.summary).toContain(quoted(name));
      }
    }
  });

  it('escapes controls, bidi and quotes, and caps at 80 characters', () => {
    expect(quoted('Eve\n[test]')).toBe('"Eve\\u{a}[test]"');
    expect(quoted('Eve\u202e')).toBe('"Eve\\u{202e}"');
    expect(quoted('a"b\\c')).toBe('"a\\"b\\\\c"');
    expect(safeText('A'.repeat(100))).toBe(`${'A'.repeat(80)}…`);
    expect(safeText('é'.repeat(80))).toBe('é'.repeat(80));
  });

  it('the phrase to type is the email only when it can be read and typed as it is', () => {
    const c = { id: 'cus_1', name: null };

    expect(confirmPhrase({ ...c, email: 'chen@wei.studio' })).toBe(
      'chen@wei.studio',
    );
    expect(confirmPhrase({ ...c, email: null })).toBe('cus_1');
    expect(confirmPhrase({ ...c, email: 'eve\u202e@x.io' })).toBe('cus_1');
    expect(confirmPhrase({ ...c, email: 'eve @x.io' })).toBe('cus_1');
  });

  it('a summary with no name uses the quoted email, else the id', async () => {
    const s = setup({
      state: (b) => ({
        customers: b.customers.map((c) =>
          c.id === 'cus_chen' ? { ...c, name: null } : c,
        ),
      }),
    });
    const [p] = await plansOf(refundJob(s.ctx), { customer: 'cus_chen' });

    expect(p.summary).toContain('to "chen@wei.studio"');
  });
});

describe('stable plans', () => {
  const jobs = [
    ['refund', refundJob, chen],
    ['cancel_subscription', cancelJob, chen],
    ['change_plan', changeJob, { ...chen, price: 'price_basic' }],
  ] as const;

  it.each(jobs)(
    '%s: the same hashes on every round within a day, new ones after midnight',
    async (_name, job, input) => {
      const s = setup();
      const spec = job(s.ctx) as Parameters<typeof hashesOf>[0];
      const at = async (t: number) => {
        s.clock.now = t;

        return hashesOf(spec, input as never);
      };
      const first = await at(NOW);

      // Rounds of an approval, and a consent code approved later the same day.
      for (const t of [
        NOW + 1,
        NOW + 600,
        NOW + 3600,
        NOW + 13 * 3600 + 59 * 60,
      ]) {
        expect(await at(t)).toEqual(first);
      }

      const tomorrow = await at(NOW + 14 * 3600);

      expect(tomorrow).toHaveLength(first.length);
      expect(tomorrow).not.toEqual(first);
      // And stable again all of the next day.
      expect(await at(NOW + 14 * 3600 + 20 * 3600)).toEqual(tomorrow);
    },
  );

  it('what changes at midnight is the time-dependent part only', async () => {
    const s = setup();
    const [full, unused] = await plansOf(refundJob(s.ctx), chen);

    s.clock.now = NOW + D;

    const [full2, unused2] = await plansOf(refundJob(s.ctx), chen);

    expect(full2.summary).toBe(full.summary);
    expect(unused.summary).toContain('unused 15 days');
    expect(unused2.summary).toContain('unused 14 days');
  });
});
