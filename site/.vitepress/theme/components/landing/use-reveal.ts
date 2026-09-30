/**
 * The thread's playback on the page (the playhead itself is playhead.ts). It follows the run's
 * phase (a run starting clears the thread, one landing plays it, a failure shows it), plays
 * only with motion allowed, the thread beside the slip and the exchange in view, and gives up
 * and shows the recording if no run has landed 8s after the page starts. If the CSS already
 * showed the held-back recording (a slow start), or the visitor pressed Skip before the run
 * landed, that run leaves everything on show.
 */
import { onBeforeUnmount, onMounted, type Ref, ref, watch } from 'vue';
import { playhead } from './playhead';
import { onPhase } from './thread';
import type { Phase } from './use-slip';

/** If no run has landed this long after the page starts, show the recording as it is. */
const GIVE_UP_MS = 8000;

const motionOk = () =>
  typeof matchMedia === 'function' &&
  !matchMedia('(prefers-reduced-motion: reduce)').matches;
/** On one column the thread sits above the slip, off screen from whoever looks at the slip. */
const sideBySide = () => matchMedia('(min-width: 960px)').matches;

/** Whether landing.css's 5s fallback has already put the held-back recording on show. */
const shownByCss = (area: HTMLElement | null) => {
  const msg = area?.querySelector('[data-message]');

  return Boolean(msg && getComputedStyle(msg).opacity !== '0');
};

export function useReveal(
  phase: Ref<Phase>,
  area: Ref<HTMLElement | null>,
  count: () => number,
) {
  const p = playhead({
    count,
    autoplay: () => motionOk() && sideBySide(),
    replayable: motionOk,
  });
  /** Set once the page runs, so the CSS stops holding the hero back for it. */
  const ready = ref(false);
  let giveUp: ReturnType<typeof setTimeout> | undefined;
  let observer: IntersectionObserver | undefined;
  /** The run on its way leaves everything on show (a slow start, or Skip before it landed). */
  let quiet = false;

  watch(phase, (now, before) => {
    const act = onPhase(before, now);

    if (quiet && act) {
      quiet = act === 'clear';

      if (act !== 'clear') {
        p.show();
      }
    } else if (act) {
      p[act === 'clear' ? 'clear' : act === 'play' ? 'play' : 'show']();
    }
  });

  onMounted(() => {
    // Checked before `ready` reaches the DOM and lifts the hold.
    quiet = shownByCss(area.value);
    ready.value = true;

    if (quiet || !motionOk() || !sideBySide()) {
      return;
    }

    p.clear();
    giveUp = setTimeout(() => {
      if (phase.value === 'loading' || phase.value === 'checking') {
        p.show();
      }
    }, GIVE_UP_MS);

    if (area.value && 'IntersectionObserver' in window) {
      // In view once a good part of the exchange is on screen; the latest entry wins.
      observer = new IntersectionObserver(
        (es) => p.seen(es[es.length - 1].isIntersecting),
        { threshold: 0.35 },
      );
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
    /** Show it all; a run still on its way then lands without playing. */
    skip: () => {
      p.show();
      quiet = phase.value === 'loading' || phase.value === 'checking';
    },
  };
}
