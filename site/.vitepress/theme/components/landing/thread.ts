/**
 * The exchange the hero plays beside the slip, as the messages a person would see pass between
 * them: their request to the agent, the agent's intent to the service, the service's proposals
 * and the policy's answer to the commit; then, as the visitor acts, their approval, the
 * receipt and the undo. Each has the wire line and a sentence on what it means, built from the
 * real frames of the run.
 *
 * Pure, with no runtime imports, so Node can load it in tests.
 */
import type { Scene } from './scenes';
import type { Tone } from './tone';
import type { Phase } from './use-slip';

/** How the commit was answered: the service asks the person, or it went through. */
export type Outcome = 'asks' | 'within';

/** What a run has produced; later parts are null until the run reaches them. */
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

export interface Message {
  /** Who says it to whom, as `Your agent → shop.example`. */
  from: string;
  text: string;
  /** The wire line behind it, or empty for the person's own words. */
  wire: string;
  /** The policy's answer takes the colour of the state it lands in. */
  tone: Tone;
}

/** The messages before the slip: after the fourth, the slip arrives. */
export const LEAD = 4;

/** What the visitor did after the slip arrived, from the slip's views. */
export interface After {
  /** The receipt's id and undo deadline, once committed through the visitor's approval. */
  approved: { id: string; undoUntil: string | null } | null;
  /** The undo's receipt and the receipt it reverses. */
  undone: { id: string; undoes: string } | null;
}

const NONE: After = { approved: null, undone: null };

export function thread(p: Progress, after: After = NONE): Message[] {
  return [...lead(p), ...acted(p, after)];
}

function lead(p: Progress): Message[] {
  const { scene, proposals, outcome } = p;
  const n = proposals?.count ?? 0;

  return [
    {
      from: 'You → your agent',
      text: `“${scene.request}.”`,
      wire: '',
      tone: 'plain',
    },
    {
      from: `Your agent → ${scene.host}`,
      text: 'It sends what you want as an intent. Nothing happens yet.',
      wire: `→ INTENT ${scene.capability} ${JSON.stringify(p.params)}`,
      tone: 'plain',
    },
    {
      from: `${scene.host} → your agent`,
      text:
        n === 1
          ? 'One proposal, with its effects up front. The agent picks it and commits.'
          : `${n} proposals, each with its effects up front. The agent picks the first and commits.`,
      wire: proposals ? `← [${proposals.id}] ${proposals.summary}` : '',
      tone: 'plain',
    },
    answer(scene, outcome, p.answer),
  ];
}

function answer(scene: Scene, outcome: Outcome | null, said: string): Message {
  const from = `Your policy, at ${scene.host}`;

  // Inside the policy, the commit simply goes through: the service answers with the receipt.
  if (outcome === 'within') {
    return {
      from: `${scene.host} → your agent`,
      text: `${scene.why} So it goes ahead, and you can still undo it.`,
      wire: `✓ receipt ${said}`,
      tone: 'green',
    };
  }

  return {
    from,
    text: outcome ? `${scene.why} So ${scene.host} asks you.` : '',
    wire: outcome ? `✗ consent_required: ${said}` : '',
    tone: outcome ? 'amber' : 'plain',
  };
}

/** The visitor's approval and the receipt it gets, then the undo. */
function acted(p: Progress, after: After): Message[] {
  const { scene, proposals, outcome } = p;
  const out: Message[] = [];
  const r = after.approved;

  if (outcome === 'asks' && r) {
    out.push(
      {
        from: `You → ${scene.host}`,
        text: 'You approve it: the page signs a one-time grant for this exact proposal.',
        wire: `→ COMMIT ${proposals?.id ?? ''} + your consent grant`,
        tone: 'plain',
      },
      {
        from: `${scene.host} → your agent`,
        text: `${scene.done}${r.undoUntil ? ` It can be undone until ${r.undoUntil}.` : ''}`,
        wire: `✓ receipt ${r.id}`,
        tone: 'green',
      },
    );
  }

  if (after.undone) {
    out.push({
      from: `You → ${scene.host}`,
      text: `You undo it. ${scene.undone}`,
      wire: `↶ undid ${after.undone.undoes} (receipt ${after.undone.id})`,
      tone: 'plain',
    });
  }

  return out;
}

/**
 * What the thread does when the run's phase changes: a run starting clears it, a run landing
 * plays it, and a failure shows whatever there is at once.
 */
export function onPhase(
  before: Phase | undefined,
  now: Phase,
): 'clear' | 'play' | 'show' | null {
  if (now === 'checking') {
    return 'clear';
  }

  if (before === 'checking' && (now === 'waiting' || now === 'committed')) {
    return 'play';
  }

  return now === 'error' || now === 'unavailable' ? 'show' : null;
}
