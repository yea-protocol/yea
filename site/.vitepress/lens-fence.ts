/**
 * Colours Lens in the docs' plain-text code blocks by protocol state, the way the playground and
 * the landing do: each line gets the class `lens-<state>` from the shared lineClass, and
 * style.css maps those classes to the state colours. Other languages are left alone.
 */
import type { MarkdownOptions } from 'vitepress';
import { lineClass } from './theme/components/lens-lines.ts';

type Transformer = NonNullable<MarkdownOptions['codeTransformers']>[number];

/** Fence languages that hold Lens or other plain output. */
const PLAIN = new Set(['', 'txt', 'text', 'plaintext', 'lens']);

/** A block that asks for approval: its ✗ lines are consent requests (amber), not refusals. */
const CONSENT =
  /consent_required|approval needed|needs your approval|^consent: /im;

export const lensLines: Transformer = {
  name: 'yea:lens-lines',
  line(node, line) {
    if (!PLAIN.has(this.options.lang ?? '')) {
      return;
    }

    const source = this.source;
    const text = source.split('\n')[line - 1] ?? '';
    const cls = text.startsWith('→ ')
      ? 'wire'
      : lineClass(text, CONSENT.test(source));

    if (cls) {
      this.addClassToHast(node, `lens-${cls}`);
    }
  },
};
