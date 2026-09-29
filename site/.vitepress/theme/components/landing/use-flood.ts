/**
 * The hero band's change of colour. When the tone changes, the new colour spreads as a
 * circle from the control the visitor pressed (or the band's centre, when nothing was
 * pressed) until it covers the band, then becomes the band's own colour. Under reduced
 * motion the spread takes no time, so the band just changes.
 */
import { type Ref, ref, watch } from 'vue';
import type { Tone } from './tone';

/** A spread in progress: where it starts, relative to the band, and how far it must reach. */
export interface Flood {
  key: number;
  x: number;
  y: number;
  r: number;
}

interface Point {
  x: number;
  y: number;
}

const centre = (b: DOMRect): Point => ({
  x: b.left + b.width / 2,
  y: b.top + b.height / 2,
});

/** The distance from a point in the band to its farthest corner. */
const reach = (b: DOMRect, p: Point) =>
  Math.hypot(
    Math.max(p.x - b.left, b.right - p.x),
    Math.max(p.y - b.top, b.bottom - p.y),
  );

export function useFlood(tone: Ref<Tone>, band: Ref<HTMLElement | null>) {
  /** The band's settled colour; `tone` is where it's heading. */
  const base = ref<Tone>(tone.value);
  const flood = ref<Flood | null>(null);
  let pressed: Point | null = null;
  let key = 0;

  /** Remember the control the visitor used, so the next change spreads from it. */
  function press(e: Event) {
    const control =
      e.target instanceof Element ? e.target.closest('button, a') : null;

    pressed = control ? centre(control.getBoundingClientRect()) : null;
  }

  function settle() {
    base.value = tone.value;
    flood.value = null;
  }

  watch(tone, () => {
    const box = band.value?.getBoundingClientRect();
    const from = pressed ?? (box ? centre(box) : null);

    pressed = null;

    if (!box || !from) {
      settle();

      return;
    }

    key += 1;
    flood.value = {
      key,
      x: from.x - box.left,
      y: from.y - box.top,
      r: reach(box, from),
    };
  });

  return { base, flood, press, settle };
}
