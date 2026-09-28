/** The rule for each known caveat (SPEC §6.3): the shape its value must have, when it denies a request, and whether a principal may consent past it. */
import { exceeds, isRisk } from '../risk.js';
import type { Risk, Verb } from '../types.js';
import { isLimit, isUses, type Limit } from '../uses.js';
import { isStringList } from '../util.js';
import type { CheckContext } from './context.js';
import { overLimit } from './limits.js';

export const CONSENTABLE = new Set(['each', 'total', 'risk']);

/** Shape validators for each known caveat's value. */
const VALID_CAVEAT: Record<string, (v: unknown) => boolean> = {
  svc: isStringList,
  verbs: isStringList,
  can: isStringList,
  exp: Number.isSafeInteger,
  nbf: Number.isSafeInteger,
  each: isLimit,
  total: isLimit,
  risk: isRisk,
  only: (v) => typeof v === 'string',
};

/** Caveats with malformed values fail closed (as a hard failure). */
export function malformed(
  k: string,
  v: unknown,
  env: CaveatEnv,
): string | null {
  // unknown keys are handled by caveatDenial
  const ok = Object.hasOwn(VALID_CAVEAT, k) ? VALID_CAVEAT[k](v) : true;

  if (!ok) {
    return `malformed caveat ${JSON.stringify({ [k]: v })}`;
  }

  const p = env.p;

  // A ceiling can't be judged against an unknown risk (SPEC §6.3), so that fails closed too.
  if (k === 'risk' && p && !isRisk(p.risk)) {
    return 'unknown risk on the proposal';
  }

  // A limit can't be judged against a malformed `uses` (SPEC §6.3), so that fails closed too.
  const isLimitCaveat = k === 'each' || k === 'total';

  // `undefined` means absent; JSON can't carry it, so a `null` is still malformed.
  return isLimitCaveat && p && p.uses !== undefined && !isUses(p.uses)
    ? 'malformed uses on the proposal'
    : null;
}

function matchCapability(pattern: string, cap: string): boolean {
  return (
    pattern === '*' ||
    pattern === cap ||
    (pattern.endsWith('*') && cap.startsWith(pattern.slice(0, -1)))
  );
}

/** What a caveat is checked against: the request, the time, and the block it sits in. */
export interface CaveatEnv {
  ctx: CheckContext;
  t: number;
  /** The proposal, for COMMIT only. */
  p: CheckContext['proposal'];
  blockId: string;
}

/**
 * Per-key checks of a well-formed caveat value (already shape-validated by `malformed`):
 * why it denies the request, or null if it allows it.
 */
const CAVEAT_CHECKS: Record<
  string,
  (v: unknown, env: CaveatEnv) => string | null
> = {
  svc: (v, { ctx }) =>
    (v as string[]).includes(ctx.service)
      ? null
      : `not valid for service ${ctx.service}`,
  verbs: (v, { ctx }) =>
    (v as Verb[]).includes(ctx.verb) ? null : `does not allow ${ctx.verb}`,
  can: (v, { ctx }) =>
    (v as string[]).some((pat) => matchCapability(pat, ctx.capability))
      ? null
      : `does not cover ${ctx.capability}`,
  exp: (v, { t }) => (t < (v as number) ? null : 'grant has expired'),
  nbf: (v, { t }) => (t >= (v as number) ? null : 'grant is not valid yet'),
  each: (v, { p }) =>
    overLimit(p, v as Limit, 0n, 'over the per-commit limit of'),
  total: (v, { ctx, p, blockId }) => {
    const l = v as Limit;

    return overLimit(
      p,
      l,
      ctx.used?.(blockId, l.of) ?? 0n,
      'would pass the total limit of',
    );
  },
  // `v` is a known risk: malformed() rejects any other ceiling before this runs.
  risk: (v, { p }) =>
    p && exceeds(p.risk, v as Risk)
      ? `risk ${p.risk} exceeds ceiling ${v}`
      : null,
  only: (v, { ctx, p }) =>
    ctx.verb === 'COMMIT' && p?.hash !== v
      ? 'grant is bound to a different proposal'
      : null,
};

/** Why the single-key caveat `c` = `{k: v}` denies the request; unknown caveats always do. */
export function caveatDenial(
  c: object,
  k: string,
  v: unknown,
  env: CaveatEnv,
): string | null {
  if (!Object.hasOwn(CAVEAT_CHECKS, k)) {
    return `unknown caveat ${JSON.stringify(c)}`;
  }

  return CAVEAT_CHECKS[k](v, env);
}
