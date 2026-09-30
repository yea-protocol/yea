/**
 * Colour is protocol state, at page scale too: the tone a surface takes from where the
 * exchange stands. Amber waits on the person, green is committed, red failed, and plain is
 * the page's own colour, for everything with no state or no longer waiting.
 */
import type { Phase } from './use-slip';

export type Tone = 'amber' | 'green' | 'red' | 'plain';

/**
 * The hero band's tone for each slip phase. The page first paints the recorded proposal,
 * which is waiting on the person, so loading is amber too; if the core can't start, nothing
 * waits on anyone, and the band is plain. While a run is on its way, and while its thread
 * plays, nothing waits yet, so it's plain too.
 */
const PHASE_TONE: Record<Phase, Tone> = {
  loading: 'amber',
  unavailable: 'plain',
  checking: 'plain',
  waiting: 'amber',
  approving: 'amber',
  committed: 'green',
  undoing: 'green',
  undone: 'plain',
  expired: 'plain',
  error: 'red',
};

export const phaseTone = (p: Phase): Tone => PHASE_TONE[p];
