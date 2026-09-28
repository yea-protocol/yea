/**
 * Risk levels (SPEC §5.1), lowest first: one order for grants, policy and approval. Any other
 * value is malformed, and every comparison here fails closed on one.
 */
import type { Risk } from './types.js';

const RISKS: readonly Risk[] = ['low', 'medium', 'high'];

export const isRisk = (v: unknown): v is Risk => RISKS.includes(v as Risk);

/** A risk's place in the order; an unknown one ranks above every known one. */
const rank = (r: unknown) => (isRisk(r) ? RISKS.indexOf(r) : RISKS.length);

/**
 * Whether `r` is `floor` or riskier. Fails closed for a gate such as `outOfBand`: an unknown
 * `r` meets every floor, and an unknown `floor` is met by every risk.
 */
export const atLeast = (r: Risk, floor: Risk) =>
  !isRisk(floor) || rank(r) >= rank(floor);

/**
 * Whether `r` is riskier than `ceiling`, as a `risk` caveat checks it. Fails closed: an unknown
 * `r` exceeds every ceiling, and an unknown `ceiling` is exceeded by every risk.
 */
export const exceeds = (r: Risk, ceiling: Risk) =>
  !isRisk(ceiling) || rank(r) > rank(ceiling);

/**
 * The first of `risks` that is set, else `fallback`, and it must be a known risk. Only
 * `undefined` falls through: a `null` is a value, so it is refused rather than defaulted.
 */
export function resolveRisk(fallback: Risk, ...risks: unknown[]): Risk {
  const set = risks.find((r) => r !== undefined);

  return set === undefined ? fallback : knownRisk(set);
}

/** `risk` if it is a known risk; throws otherwise, so a plan with one never goes further. */
export function knownRisk(risk: unknown): Risk {
  if (!isRisk(risk)) {
    throw new TypeError(`plan has an unknown risk: ${JSON.stringify(risk)}`);
  }

  return risk;
}
