/**
 * Colours Lens in the docs' plain-text code blocks by protocol state, the way the playground and
 * the landing do: each line gets the class `lens-<state>` from the shared lineClass, and
 * style.css maps those classes to the state colours. Fences in `text`, `txt`, `lens` or no
 * language are read as Lens; `plaintext` and other languages are left alone, and so is any fence
 * whose info string says `no-lens` (output that looks like Lens but isn't, such as YAML-ish
 * lists).
 */
import type { MarkdownOptions } from 'vitepress';
import { lineClass } from './theme/components/lens-lines.ts';

type Transformer = NonNullable<MarkdownOptions['codeTransformers']>[number];
type HastElement = Parameters<NonNullable<Transformer['code']>>[0];

/** Fence languages that hold Lens. */
const LENS = new Set(['', 'txt', 'text', 'lens']);

/** A ✗ line that asks for approval is a consent request (amber), not a refusal (red). */
const CONSENT = /consent_required|approval needed|needs your approval/i;

/** The class for one line of Lens, or '' for a plain line. */
export function lensClass(text: string): string {
  if (text.startsWith('→ ')) {
    return 'wire';
  }

  return lineClass(text, CONSENT.test(text));
}

export const lensFence: Transformer = {
  name: 'yea:lens-lines',
  code(node) {
    const meta = String(this.options.meta?.__raw ?? '');

    if (!LENS.has(this.options.lang ?? '') || /\bno-lens\b/.test(meta)) {
      return;
    }

    const texts = this.source.split('\n');
    const lines = node.children.filter(isLine);

    lines.forEach((line, i) => {
      const cls = lensClass(texts[i] ?? '');

      if (cls) {
        this.addClassToHast(line, `lens-${cls}`);
      }
    });
  },
};

function isLine(n: HastElement['children'][number]): n is HastElement {
  return n.type === 'element' && n.tagName === 'span';
}
