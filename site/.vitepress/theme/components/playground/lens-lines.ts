/**
 * What the reply pane shows of one exchange: its Lens, one line per EVENT, the token counts
 * of the Lens and the JSON (SPEC §8), and a colour class for each Lens line.
 */

import { needsConsent } from './labels';
import type { Core, Exchange } from './model';

/** The SDK functions the view needs. */
export type LensKit = Pick<Core, 'lens' | 'est'>;

export interface LensLine {
  text: string;
  cls: string;
}

export interface LensView {
  /** The reply's Lens, as a model reads it (and Copy copies it). */
  text: string;
  lines: LensLine[];
  events: string[];
  tokens: { lens: number; json: number; pretty: number };
}

/** A Lens line's class: its protocol state, an effect, or a handle for more. */
export function lineClass(l: string, consent: boolean): string {
  if (l.startsWith('✓')) {
    return 'green';
  }

  if (l.startsWith('✗')) {
    return consent ? 'amber' : 'red';
  }

  if (l.startsWith('? ') || /^\d+ proposals?/.test(l) || /^\[p_/.test(l)) {
    return 'amber';
  }

  if (l.startsWith('… ') && l.includes(' more at ')) {
    return 'more';
  }

  return /^ {2}[~+\-$>*] /.test(l) ? 'effect' : '';
}

export function lensView(kit: LensKit, x: Exchange): LensView {
  const text = x.reply.lens ?? kit.lens(x.reply);
  const consent = needsConsent(x.reply);

  return {
    text,
    lines: text
      .split('\n')
      .map((l) => ({ text: l, cls: lineClass(l, consent) })),
    events: x.events.map((e) => kit.lens(e)),
    tokens: {
      lens: kit.est(text),
      json: kit.est(JSON.stringify(x.reply)),
      pretty: kit.est(JSON.stringify(x.reply, null, 2)),
    },
  };
}
