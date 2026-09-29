/**
 * What the reply pane shows of one exchange: its Lens, one line per EVENT, the token counts
 * of the Lens and the JSON (SPEC §8), and a colour class for each Lens line.
 */
import { lineClass } from '../lens-lines';
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
