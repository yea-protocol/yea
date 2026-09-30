/**
 * The thread's playhead: how far the messages have played, whether they're playing, and
 * whether the slip is here, with the moves that change them. A run starting clears it and
 * sends the slip away; playing brings the messages one at a time and the slip after the
 * fourth; Replay (asked) plays the messages again and leaves the slip alone; show puts it all
 * on screen at once.
 *
 * Its only runtime imports are Vue's refs and a `.ts` file, so the tests can run it under Node.
 */
import { ref } from 'vue';
import { LEAD } from './thread.ts';

/** The pause before the first message, then between messages, then before the slip, in ms. */
export const FIRST_MS = 500;
export const NEXT_MS = 1250;
export const SLIP_MS = 1000;

export interface PlayheadEnv {
  /** How many messages there are; it can grow while playing (the visitor acts). */
  count: () => number;
  /** Whether a run's thread plays by itself (motion allowed, thread beside the slip). */
  autoplay: () => boolean;
  /** Whether a replay the visitor asks for can play (motion allowed). */
  replayable: () => boolean;
}

export function playhead(env: PlayheadEnv) {
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

    if (reveal.value >= env.count() && landed.value) {
      playing.value = false;
    } else {
      const slipNext = reveal.value === LEAD && !landed.value;

      timer = setTimeout(beat, slipNext ? SLIP_MS : NEXT_MS);
    }
  };

  /** A run has started: empty the thread and send the slip away until it lands. */
  const clear = () => {
    if (env.autoplay()) {
      clearTimeout(timer);
      reveal.value = 0;
      playing.value = true;
      landed.value = false;
    }
  };

  /**
   * Play from the start. A run landing plays only by itself and in view; otherwise it all
   * shows. Asked for (Replay), it plays wherever motion is allowed: the press proves it's seen.
   */
  const play = (asked = false) => {
    if (asked ? !env.replayable() : !env.autoplay() || !inView) {
      show();

      return;
    }

    clearTimeout(timer);
    reveal.value = 0;
    playing.value = true;
    timer = setTimeout(beat, FIRST_MS);
  };

  return {
    reveal,
    playing,
    landed,
    show,
    clear,
    play,
    seen: (now: boolean) => {
      inView = now;
    },
    stop: () => clearTimeout(timer),
  };
}
