/**
 * The slip's deadlines: while a proposal waits on the person, or a receipt's undo window is
 * open, the slip says when it (or the example policy) has run out, before a step would fail
 * and on a timer.
 */
import { watch } from 'vue';
import { type Lapse, lapsed, lapseText } from './expiry';
import { utcClock } from './slip-view';
import type { Live, SlipState } from './use-slip';

const nowSec = () => Math.floor(Date.now() / 1000);

/** The deadline that matters in the current phase, and what runs out at it. */
function deadline(state: SlipState, live: Live): [Lapse, number] | null {
  if (state.phase.value === 'waiting' && live.waiting) {
    return ['proposal', live.waiting.proposal.expires];
  }

  const until = state.receipt.value?.until;

  return state.phase.value === 'committed' && until != null
    ? ['undo', until]
    : null;
}

/** If the policy or the phase's deadline has run out, say so and stop; true if it had. */
export function stopIfLapsed(state: SlipState, live: Live): boolean {
  const grant = live.session?.grantExpires ?? Number.POSITIVE_INFINITY;
  const d = deadline(state, live);
  const l = lapsed(nowSec(), {
    grant,
    proposal: d?.[0] === 'proposal' ? d[1] : null,
    undo: d?.[0] === 'undo' ? d[1] : null,
  });

  if (!l) {
    return false;
  }

  const at = l === 'policy' ? grant : (d?.[1] ?? nowSec());

  state.error.value = lapseText(l, utcClock(at));
  state.status.value = state.error.value;
  state.phase.value = 'expired';

  return true;
}

/** While a proposal waits or an undo window is open, stop the slip when it runs out. */
export function watchDeadlines(state: SlipState, current: () => Live | null) {
  let timer: ReturnType<typeof setTimeout> | undefined;

  watch(state.phase, () => {
    clearTimeout(timer);

    const live = current();
    const d = live && deadline(state, live);

    if (live && d) {
      timer = setTimeout(
        () => stopIfLapsed(state, live),
        (d[1] - nowSec()) * 1000 + 500,
      );
    }
  });
}
