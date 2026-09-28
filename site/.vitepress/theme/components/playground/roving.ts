/**
 * Arrow-key movement for a group with one tab stop (a radiogroup or a tablist): which item
 * a key moves to, wrapping at the ends, and moving focus there.
 */

const STEP: Record<string, number> = {
  ArrowRight: 1,
  ArrowDown: 1,
  ArrowLeft: -1,
  ArrowUp: -1,
};

/** The index `key` moves to from `i` among `n` items, or null for any other key. */
export function moveIndex(key: string, i: number, n: number): number | null {
  if (key === 'Home') {
    return 0;
  }

  if (key === 'End') {
    return n - 1;
  }

  const step = STEP[key];

  return step === undefined ? null : (i + step + n) % n;
}

/** Focus the `index`th sibling of the element that got the key. */
export function focusSibling(e: KeyboardEvent, index: number) {
  const item = e.currentTarget;
  const sibling =
    item instanceof HTMLElement ? item.parentElement?.children[index] : null;

  if (sibling instanceof HTMLElement) {
    sibling.focus();
  }
}
