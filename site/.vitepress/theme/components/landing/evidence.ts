/**
 * The evidence chart's rows, derived from numbers.ts: each task's cost in both arms, how much
 * more YEA cost, and bar lengths on one shared scale that starts at zero.
 *
 * No runtime imports, so the tests can load it under Node.
 */

export interface CostInput {
  task: string;
  rest: number;
  yea: number;
}

export interface CostRow extends CostInput {
  /** YEA's extra cost over REST, rounded to a whole percent: `+9%`. */
  delta: string;
  /** Bar lengths as a percentage of the widest bar. */
  restBar: number;
  yeaBar: number;
}

/** A cost in dollars to three places: `$0.098`. */
export const dollars = (usd: number) => `$${usd.toFixed(3)}`;

/** Signed whole-percent change from `from` to `to`: `+9%`, `-4%`, `0%`. */
export function percentChange(from: number, to: number): string {
  const pct = Math.round(((to - from) / from) * 100);

  return pct > 0 ? `+${pct}%` : `${pct}%`;
}

/** Bar lengths share one zero-based scale, so similar costs look similar. */
export function costRows(tasks: readonly CostInput[]): CostRow[] {
  const max = Math.max(...tasks.flatMap((t) => [t.rest, t.yea]));
  const bar = (v: number) => Math.round((v / max) * 1000) / 10;

  return tasks.map((t) => ({
    ...t,
    delta: percentChange(t.rest, t.yea),
    restBar: bar(t.rest),
    yeaBar: bar(t.yea),
  }));
}

/** The range of YEA's extra cost across tasks: `3–15%`. */
export function deltaRange(tasks: readonly CostInput[]): string {
  const pcts = tasks.map((t) => Math.round(((t.yea - t.rest) / t.rest) * 100));

  return `${Math.min(...pcts)}–${Math.max(...pcts)}%`;
}
