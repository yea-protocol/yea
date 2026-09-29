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
 * has no gaps. When a heading skips a level, it and the rest of its run (everything nested
 * under it, and its siblings) are lifted by the same amount, until a heading above the run's
 * source level ends it. Headings that don't skip keep their level.
 */
export function headingOrder(md: MarkdownRenderer): void {
  md.core.ruler.after('inline', 'heading-order', (state) => {
    const level = headingLevels();
    let current = 0;

    for (const tok of state.tokens) {
      if (tok.type === 'heading_open') {
        current = level(Number(tok.tag.slice(1)));
        tok.tag = `h${current}`;
      } else if (tok.type === 'heading_close') {
        tok.tag = `h${current}`;
      }
    }
  });
}

/** A skipped run: its first heading's source level, and how far the run is lifted. */
interface Run {
  from: number;
  lift: number;
}

/** Maps each heading's source level, in document order, to the level it renders at. */
export function headingLevels(): (source: number) => number {
  const runs: Run[] = [];
  let previous = 0;

  return (source) => {
    while (runs.length && source < (runs.at(-1)?.from ?? 0)) {
      runs.pop();
    }

    let level = source - runs.reduce((n, r) => n + r.lift, 0);

    if (previous && level > previous + 1) {
      runs.push({ from: source, lift: level - previous - 1 });
      level = previous + 1;
    }

    previous = level;

    return level;
  };
}

function plainText(children: Token[]): string {
  return children
    .filter((t) => ['text', 'text_special', 'code_inline'].includes(t.type))
    .map((t) => t.content)
    .join('')
    .trim();
}
