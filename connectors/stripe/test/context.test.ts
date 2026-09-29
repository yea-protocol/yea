/**
 * The rules every job shares (src/context.ts): the risk table and mode tag, and plans whose
 * hashes stay the same all day.
 */
import { describe, expect, it } from 'vitest';
import { cancelJob, changeJob, refundJob } from '../src/jobs.js';
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
