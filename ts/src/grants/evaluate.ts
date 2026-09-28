/** Evaluating every caveat of a grant: a non-object is hard at once, then malformed(), then each rule, sorted into hard and soft denials. */
import { exact, type Limit } from '../uses.js';
import { isObject, unixNow } from '../util.js';
import {
  type CaveatEnv,
  CONSENTABLE,
  caveatDenial,
  malformed,
} from './caveat-rules.js';
import type { CheckContext, TotalLimit } from './context.js';
import { type Block, blockId, type Caveat } from './token.js';

interface CaveatFailure {
  c: Caveat;
  why: string;
}

export interface CaveatResults {
  /** Denials no one can override. */
  hard: CaveatFailure[];
  /** Denials a principal may approve (limits and risk ceilings). */
  soft: CaveatFailure[];
  /** `total` limits this COMMIT counts against. */
  totals: TotalLimit[];
}

/** Check one caveat, recording a denial (hard or soft) or the total it counts against. */
function evaluateCaveat(c: unknown, env: CaveatEnv, out: CaveatResults) {
  if (!isObject(c)) {
    out.hard.push({
      c: c as Caveat,
      why: `malformed caveat ${JSON.stringify(c)}`,
    });

    return;
  }

  const keys = Object.keys(c);
  const k = keys.length === 1 ? keys[0] : '';
  const v = c[k];
  const bad = malformed(k, v, env);

  if (bad) {
    out.hard.push({ c: c as Caveat, why: bad });

    return;
  }

  const why = caveatDenial(c, k, v, env);

  if (why) {
    (CONSENTABLE.has(k) ? out.soft : out.hard).push({ c: c as Caveat, why });
  } else if (k === 'total' && env.ctx.verb === 'COMMIT') {
    const l = v as Limit;

    out.totals.push({
      id: env.blockId,
      of: l.of,
      max: exact({ amount: l.max, scale: l.scale }),
    });
  }
}

/** Check every caveat of every block. Fails closed: anything unrecognized is a hard denial. */
export async function evaluateCaveats(
  blocks: Block[],
  ctx: CheckContext,
): Promise<CaveatResults> {
  const t = ctx.now ?? unixNow();
  const p = ctx.verb === 'COMMIT' ? ctx.proposal : undefined;
  const out: CaveatResults = { hard: [], soft: [], totals: [] };

  for (const b of blocks) {
    const env = { ctx, t, p, blockId: await blockId(b) };
    const caveats: unknown[] = b.p.caveats; // decoded but not yet validated

    for (const c of caveats) {
      evaluateCaveat(c, env, out);
    }
  }

  return out;
}
