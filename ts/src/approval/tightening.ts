/** The unsigned part of a policy (SPEC-approval §2): read leniently, and it can only tighten. */
import { isRisk } from '../risk.js';
import type { Risk } from '../types.js';
import { isObject } from '../util.js';

/** The unsigned part of a policy: it can only tighten (SPEC-approval §2). */
export interface Tightening {
  deny: string[];
  outOfBand: Risk;
  /** What was ignored, for stderr. */
  warnings: string[];
}

/**
 * Read `~/.yea/policy.json` or server options. Unknown fields and bad values are ignored with
 * a warning, and the valid tightenings still apply; nothing here can make more run.
 */
export function readTightening(v: unknown): Tightening {
  const out: Tightening = { deny: [], outOfBand: 'high', warnings: [] };

  if (!isObject(v)) {
    out.warnings.push('the policy file is not a JSON object; ignored');

    return out;
  }

  for (const [k, x] of Object.entries(v)) {
    if (
      k === 'deny' &&
      Array.isArray(x) &&
      x.every((t) => typeof t === 'string')
    ) {
      out.deny = x;
    } else if (k === 'outOfBand' && isRisk(x)) {
      out.outOfBand = x;
    } else {
      out.warnings.push(
        `ignored ${JSON.stringify(k)}: ${k === 'deny' || k === 'outOfBand' ? 'bad value' : 'unknown field'}`,
      );
    }
  }

  return out;
}
