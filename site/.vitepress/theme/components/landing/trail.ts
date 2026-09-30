/**
 * The lead-up the hero shows above the slip: the four stops from the person's request to the
 * outcome. The agent asks, the service proposes, the policy checks the commit, and then either
 * the person decides or it goes ahead. Each stop has a sentence and the wire line behind it,
 * built from the real frames of the run. The visitor steps through them; the slip and the band
 * show each stop as it was.
 *
 * No runtime imports, so Node can load it in tests.
 */
import type { Scene } from './scenes';

/** How the commit was answered: the service asks the person, or it went through. */
export type Outcome = 'asks' | 'within';

/** What a run has produced so far; later parts are null until the run reaches them. */
export interface Progress {
  scene: Scene;
  /** The intent's params, as sent. */
  params: Record<string, unknown>;
  /** How many proposals came back, and the first, which the agent picks. */
  proposals: { count: number; id: string; summary: string } | null;
  outcome: Outcome | null;
  /** The service's reason for asking, or the receipt's id when it went through. */
  answer: string;
}

/** The index of the last stop, the outcome, which the lead-up shows at rest. */
export const LAST_STOP = 3;

export interface Stop {
  label: string;
  text: string;
  wire: string;
}

/** The four stops. A stop the run hasn't reached has its label and nothing else yet. */
export function stops(p: Progress): Stop[] {
  const { scene, proposals, outcome } = p;
  const pick = proposals?.id ?? 'p_…';
  const n = proposals?.count ?? 0;

  return [
    {
      label: 'Agent asks',
      text: `“${scene.request}.” Your agent sends it to ${scene.host} as an intent.`,
      wire: `→ INTENT ${scene.capability} ${JSON.stringify(p.params)}`,
    },
    {
      label: 'Service proposes',
      text: proposals
        ? `${scene.host} answers with ${n === 1 ? 'a proposal' : `${n} proposals`}, and nothing has happened yet. The agent picks ${n === 1 ? 'it' : 'the first'}.`
        : '',
      wire: proposals ? `← [${pick}] ${proposals.summary}` : '',
    },
    {
      label: 'Policy checks',
      text: proposals
        ? `The agent commits, and ${scene.host} checks the commit against the policy you signed.`
        : '',
      wire: proposals ? `→ COMMIT ${pick}` : '',
    },
    outcomeStop(scene, outcome, p.answer),
  ];
}

function outcomeStop(scene: Scene, outcome: Outcome | null, answer: string) {
  if (outcome === 'asks') {
    return {
      label: 'You decide',
      text: `${scene.why} So ${scene.host} asks you, and nothing happens until you approve.`,
      wire: `✗ consent_required: ${answer}`,
    };
  }

  if (outcome === 'within') {
    return {
      label: 'Goes ahead',
      text: `It's inside the policy you signed, so it goes ahead without asking. You can still undo it.`,
      wire: `✓ receipt ${answer}`,
    };
  }

  return { label: 'You decide', text: '', wire: '' };
}
