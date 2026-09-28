/**
 * Keeping the reply where the user is looking: when the panes stack in one column, the reply
 * sits a screen away from Send and the presets, so each new exchange brings it into view,
 * unless its top is already on screen.
 */
import { nextTick, type ShallowRef, watch } from 'vue';
import { matches, ONE_COLUMN, reducedMotion } from './viewport';

interface ReplyScrollDeps {
  /** How many exchanges there are; the reply is scrolled to when it grows. */
  count: () => number;
  /** False while the page opens on its first exchange, which shouldn't move the page. */
  enabled: () => boolean;
  pane: Readonly<ShallowRef<HTMLElement | null>>;
}

/** Whether the element's top edge is on screen, below the fixed navigation bar. */
function topInView(el: HTMLElement): boolean {
  const top = el.getBoundingClientRect().top;
  const below = Number.parseFloat(getComputedStyle(el).scrollMarginTop) || 0;

  return top >= below && top < window.innerHeight * 0.6;
}

export function useReplyScroll({ count, enabled, pane }: ReplyScrollDeps) {
  watch(count, async () => {
    if (!enabled() || !matches(ONE_COLUMN)) {
      return;
    }

    await nextTick();

    const el = pane.value;

    if (el && !topInView(el)) {
      el.scrollIntoView({
        behavior: reducedMotion() ? 'auto' : 'smooth',
        block: 'start',
      });
    }
  });
}
