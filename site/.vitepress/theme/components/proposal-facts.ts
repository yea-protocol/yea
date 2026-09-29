/**
 * The facts a person reads before approving a proposal: its effects, what it uses, its risk
 * and its undo window, worded once for both the playground's consent card and the landing's
 * slip.
 *
 * No runtime imports, so Node can load it in tests and the landing's recording script.
 */
import type {
  effectLine,
  fmtDuration,
  fmtQuantity,
  Proposal,
} from '@yea-protocol/sdk';

/** The SDK formatters the facts need. */
export interface FactsKit {
  effectLine: typeof effectLine;
  fmtQuantity: typeof fmtQuantity;
  fmtDuration: typeof fmtDuration;
}

export interface ProposalFacts {
  effects: string[];
  /** What it uses, as `spend 53.95 USD`, or null if nothing. */
  uses: string | null;
  risk: string;
  /** The undo window, as `within 2h`, or `can't be undone`. */
  undo: string;
}

export function proposalFacts(kit: FactsKit, p: Proposal): ProposalFacts {
  const uses = p.uses ?? {};
  const names = Object.keys(uses).sort();

  return {
    effects: p.effects.map((e) => kit.effectLine(e)),
    uses: names.length
      ? names.map((n) => `${n} ${kit.fmtQuantity(uses[n])}`).join(', ')
      : null,
    risk: p.risk,
    undo: p.undo
      ? `within ${kit.fmtDuration(p.undo.window)}`
      : "can't be undone",
  };
}

/** The facts as one sentence: `Uses spend 53.95 USD, risk low, undo within 2h`. */
export function factsLine(f: ProposalFacts): string {
  const parts = [
    ...(f.uses ? [`uses ${f.uses}`] : []),
    `risk ${f.risk}`,
    f.undo.startsWith('within') ? `undo ${f.undo}` : f.undo,
  ];
  const text = parts.join(', ');

  return text[0].toUpperCase() + text.slice(1);
}
