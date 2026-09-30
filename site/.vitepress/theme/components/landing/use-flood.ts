/**
 * The hero band's change of colour. When the tone changes, the new colour spreads as a
 * circle from the button the visitor just pressed (or, for a change nobody pressed for, such
 * as the slip arriving, from an anchor like the approval point) until it covers the band, then
 * becomes the band's own colour. A return to plain nobody pressed for just settles. Under
 * reduced motion the spread takes no time, so the band just changes.
 */
import { type Ref, ref, watch } from 'vue';
import type { Tone } from './tone';

/** A spread in progress: where it starts, relative to the band, and how far it must reach. */
export interface Flood {
  key: number;
  /** The tone it spreads, which the band settles on. */
  to: Tone;
  x: number;
  y: number;
  r: number;
}

/** A press, relative to the band, and when it happened. */
interface Press {
  x: number;
  y: number;
  at: number;
}

/** A press older than this didn't cause the change; the spread starts from the centre. */
const PRESS_MS = 2000;

/** The distance from a point in a box to the box's farthest corner. */
const reach = (w: number, h: number, x: number, y: number) =>
  Math.hypot(Math.max(x, w - x), Math.max(y, h - y));

export function useFlood(
  tone: Ref<Tone>,
  band: Ref<HTMLElement | null>,
  /** Where a change nobody pressed for spreads from, in the band; the centre if null. */
  anchor: () => { x: number; y: number } | null = () => null,
) {
  /** The band's settled colour; `tone` is where it's heading. */
  const base = ref<Tone>(tone.value);
  const flood = ref<Flood | null>(null);
  let pressed: Press | null = null;
  let key = 0;

  /** Remember the button the visitor pressed, so a change it causes spreads from it. */
  function press(e: Event) {
    const button =
      e.target instanceof Element ? e.target.closest('button') : null;
    const box = band.value?.getBoundingClientRect();

    if (!button || !box) {
      return;
    }

    const b = button.getBoundingClientRect();

    pressed = {
      x: b.left + b.width / 2 - box.left,
      y: b.top + b.height / 2 - box.top,
      at: Date.now(),
    };
  }

  /** The spread `k` has ended; a stale event from one it replaced changes nothing. */
  function settle(k: number) {
    if (flood.value?.key === k) {
      base.value = flood.value.to;
      flood.value = null;
    }
  }

  /**
   * A spread's element finished or was cancelled. Its key is read from the element, not the
   * current state: a replaced element reports its cancellation after the next spread began.
   */
  function ended(e: Event) {
    if (e.currentTarget instanceof HTMLElement) {
      settle(Number(e.currentTarget.dataset.key));
    }
  }

  // After the DOM updates, so the band is measured at the size the new state gives it.
  watch(
    tone,
    (to) => {
      const box = band.value?.getBoundingClientRect();
      const from =
        pressed && Date.now() - pressed.at < PRESS_MS ? pressed : null;

      pressed = null;

      // Nothing to spread over, or a quiet return to plain nobody pressed for (a run starting
      // on its own): the band just settles.
      if (!box || (!from && to === 'plain')) {
        base.value = to;
        flood.value = null;

        return;
      }

      // A spread cut short has covered most of the band: the next one spreads over it.
      if (flood.value) {
        base.value = flood.value.to;
      }

      const at = from ?? anchor() ?? { x: box.width / 2, y: box.height / 2 };
      const { x, y } = at;

      key += 1;
      flood.value = { key, to, x, y, r: reach(box.width, box.height, x, y) };
    },
    { flush: 'post' },
  );

  return { base, flood, press, settle, ended };
}
