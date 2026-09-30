/**
 * The thread's playback. A run starting clears the thread and sends the slip away; when the
 * run lands, the messages arrive one at a time and stay, and after the fourth the slip
 * arrives. Replay plays the messages again and leaves the slip, its state and the band as they
 * are; Skip shows everything at once. It plays only with motion allowed, with the thread and
 * slip side by side, and with the exchange in view; otherwise, or when a run fails, everything
 * shows at once, so nothing stays hidden from someone who never scrolls there. If the page was
 * slow and the CSS already showed the recording, the first run leaves it on show.
 */
import { onBeforeUnmount, onMounted, type Ref, ref, watch } from 'vue';
import { LEAD, onPhase } from './thread';
import type { Phase } from './use-slip';

/** The pause before the first message, then between messages, then before the slip, in ms. */
const FIRST_MS = 500;
const NEXT_MS = 1250;
const SLIP_MS = 1000;

/** If no run has landed this long after the page starts, show the recording as it is. */
const GIVE_UP_MS = 8000;
/** The CSS shows the held-back recording after 5s (landing.css); after that, don't hide it. */
const SHOWN_BY_CSS_MS = 5000;

/**
 * Whether to play at all: motion allowed, and the thread and slip side by side. On one column
 * the thread sits above the slip, off screen from whoever is looking at the slip.
 */
const motionOk = () =>
  typeof matchMedia === 'function' &&
  !matchMedia('(prefers-reduced-motion: reduce)').matches;
const moving = () => motionOk() && matchMedia('(min-width: 960px)').matches;

/** The playhead over `count()` messages, and the moves that change it. */
function player(count: () => number) {
  /** While playing, how many messages have arrived. */
  const reveal = ref(0);
  const playing = ref(false);
  /** Whether the slip is here. */
  const landed = ref(true);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inView = true;

  const show = () => {
    clearTimeout(timer);
    playing.value = false;
    landed.value = true;
  };

  const beat = () => {
    if (reveal.value === LEAD && !landed.value) {
      landed.value = true;
    } else {
      reveal.value += 1;
    }

    if (reveal.value >= count() && landed.value) {
      playing.value = false;
    } else {
      const slipNext = reveal.value === LEAD && !landed.value;

      timer = setTimeout(beat, slipNext ? SLIP_MS : NEXT_MS);
    }
  };

  /** A run has started: empty the thread and send the slip away until it lands. */
  const clear = () => {
    if (moving()) {
      clearTimeout(timer);
      reveal.value = 0;
      playing.value = true;
      landed.value = false;
    }
  };

  /**
   * Play from the start; out of view, or without motion, show it all instead. Asked for (Replay),
   * it plays on one column too.
   */
  const play = (asked = false) => {
    if (!(asked ? motionOk() : moving()) || !inView) {
      show();
    } else {
      clearTimeout(timer);
      reveal.value = 0;
      playing.value = true;
      timer = setTimeout(beat, FIRST_MS);
    }
  };

  const seen = (now: boolean) => {
    inView = now;
  };

  return {
    reveal,
    playing,
    landed,
    show,
    clear,
    play,
    seen,
    stop: () => clearTimeout(timer),
  };
}

export function useReveal(
  phase: Ref<Phase>,
  area: Ref<HTMLElement | null>,
  count: () => number,
) {
  const p = player(count);
  /** Set once the page runs, so the CSS stops holding the hero back for it. */
  const ready = ref(false);
  let giveUp: ReturnType<typeof setTimeout> | undefined;
  let observer: IntersectionObserver | undefined;
  /** The CSS already showed the recording (a slow start): the first run doesn't hide it again. */
  let quietFirst = false;

  watch(phase, (now, before) => {
    const act = onPhase(before, now);

    if (quietFirst && act) {
      quietFirst = act === 'clear';

      if (act !== 'clear') {
        p.show();
      }

      return;
    }

    if (act) {
      p[act === 'clear' ? 'clear' : act === 'play' ? 'play' : 'show']();
    }
  });

  onMounted(() => {
    ready.value = true;

    // Too late to play it: the recording has already been on show.
    if (performance.now() > SHOWN_BY_CSS_MS) {
      quietFirst = true;

      return;
    }

    if (!moving()) {
      return;
    }

    p.clear();
    giveUp = setTimeout(() => {
      if (phase.value === 'loading' || phase.value === 'checking') {
        p.show();
      }
    }, GIVE_UP_MS);

    if (area.value && 'IntersectionObserver' in window) {
      // In view once a good part of the exchange is on screen.
      observer = new IntersectionObserver(([e]) => p.seen(e.isIntersecting), {
        threshold: 0.35,
      });
      observer.observe(area.value);
    }
  });

  onBeforeUnmount(() => {
    p.stop();
    clearTimeout(giveUp);
    observer?.disconnect();
  });

  return {
    reveal: p.reveal,
    playing: p.playing,
    landed: p.landed,
    ready,
    replay: () => p.play(true),
    skip: p.show,
  };
}
