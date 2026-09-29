/** Customer text is untrusted (src/text.ts): quoted, escaped and capped wherever it shows. */
import { describe, expect, it } from 'vitest';
import { cancelJob, changeJob, refundJob } from '../src/jobs.js';
import { confirmPhrase, quoted, safeText } from '../src/text.js';
import { plansOf, setup } from './helpers.js';

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
