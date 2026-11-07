/**
 * One plan as a person reads it (docs/framework/SPEC-approval.md §3, §6): the form, the MCP
 * results and `yea approve` all show a plan with these lines.
 */
import type { ShownPlan } from '../approval.js';
import { fmtDuration, safeEffectLine } from '../lens.js';
import { printable } from '../text.js';
import { isUndoWindow } from '../undo-window.js';
import { fmtUses } from '../uses.js';

/**
 * A shown plan, or a consent code's `job` as `yea approve` reads it: its `undoWindow` comes from
 * outside, so it is checked here rather than trusted.
 */
export type PlanToShow = Omit<ShownPlan, 'undoWindow'> & {
  undoWindow?: unknown;
};

/**
 * The plan's summary (after `[n]` when `n` is given), its effects, then what it uses, its risk
 * and its undo. Service text is untrusted, so it's escaped: a summary can't forge a line or hide
 * characters. Undo is the window only when it is one (SPEC-approval §1), else `never`.
 */
export function planLines(p: PlanToShow, n?: number): string[] {
  const attrs = [
    ...(p.uses && Object.keys(p.uses).length
      ? [`uses: ${fmtUses(p.uses)}`]
      : []),
    `risk: ${p.risk}`,
    `undo: ${isUndoWindow(p.undoWindow) ? fmtDuration(p.undoWindow) : 'never'}`,
  ];

  return [
    `${n === undefined ? '' : `[${n}] `}${printable(p.summary)}`,
    ...p.effects.map((e) => `  ${safeEffectLine(e)}`),
    `  ${attrs.join(' · ')}`,
  ];
}
