/**
 * The geometry of the hero's background, the logo's idea at full size: lines (the actions an
 * agent could take) converge on one approval point, and a single line continues past it. Each
 * message of the exchange sends a line in; the proposals not picked branch off and stop. They
 * run in the gutter between the thread and the slip, never across text.
 * Pure: it takes measured points and returns SVG path data.
 */

export interface Point {
  x: number;
  y: number;
}

/** A smooth path from `a` into `to`, leaving and arriving level. */
export function converge(a: Point, to: Point): string {
  const pull = Math.max(40, (to.x - a.x) * 0.55);

  return `M${r(a.x)} ${r(a.y)} C${r(a.x + pull)} ${r(a.y)} ${r(to.x - pull)} ${r(to.y)} ${r(to.x)} ${r(to.y)}`;
}

/**
 * The branches of the proposals the agent didn't pick: from where the proposals message meets
 * the gutter, each bends away (alternately up and down) and stops short, `reach` along.
 */
export function branches(from: Point, n: number, reach: number) {
  return Array.from({ length: n }, (_, k) => {
    const side = k % 2 === 0 ? -1 : 1;
    const end = {
      x: from.x + reach,
      y: from.y + side * 30 * (1 + Math.floor(k / 2)),
    };

    return { d: converge(from, end), end };
  });
}

const r = (v: number) => Math.round(v * 10) / 10;
