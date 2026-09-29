/**
 * Markdown rules for the docs pages: GitHub-style task lists with labelled checkboxes, and
 * heading levels that never skip (included README sections put an h3 straight after the page's
 * h1).
 */
import type { MarkdownRenderer } from 'vitepress';

type StateCore = Parameters<
  Parameters<MarkdownRenderer['core']['ruler']['push']>[1]
>[0];
type Token = StateCore['tokens'][number];

/** "- [ ] item" renders as a checkbox readers can tick, named by the item's text. */
export function taskLists(md: MarkdownRenderer): void {
  md.core.ruler.after('inline', 'task-lists', (state) => {
    const toks = state.tokens;

    for (let i = 2; i < toks.length; i++) {
      const children = toks[i].children ?? [];
      const first = children[0];

      if (
        toks[i].type !== 'inline' ||
        toks[i - 2].type !== 'list_item_open' ||
        first?.type !== 'text'
      ) {
        continue;
      }

      const m = /^\[( |x)\] /i.exec(first.content);

      if (!m) {
        continue;
      }

      first.content = first.content.slice(4);

      const box = new state.Token('html_inline', '', 0);
      const label = md.utils.escapeHtml(plainText(children));

      box.content = `<input type="checkbox" class="task-list-item-checkbox" aria-label="${label}"${m[1] === ' ' ? '' : ' checked'}> `;
      children.unshift(box);
      toks[i - 2].attrJoin('class', 'task-list-item');
    }
  });
}

/**
 * A heading is at most one level below the one before it, so screen-reader heading navigation
 * has no gaps. Only headings that skip a level change.
 */
export function headingOrder(md: MarkdownRenderer): void {
  md.core.ruler.push('heading-order', (state) => {
    let previous = 0;

    for (const tok of state.tokens) {
      if (tok.type !== 'heading_open' && tok.type !== 'heading_close') {
        continue;
      }

      const level = Number(tok.tag.slice(1));

      if (tok.type === 'heading_open') {
        const fixed = previous && level > previous + 1 ? previous + 1 : level;

        tok.tag = `h${fixed}`;
        previous = fixed;
      } else {
        tok.tag = `h${previous}`;
      }
    }
  });
}

function plainText(children: Token[]): string {
  return children
    .filter((t) => t.type === 'text' || t.type === 'code_inline')
    .map((t) => t.content)
    .join('')
    .trim();
}
