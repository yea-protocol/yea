/**
 * Every benchmark figure the landing shows, in one place so a drift check can compare them
 * with bench/RESULTS.md and bench/agent-eval/RESULTS*.md. Plain literals only.
 */

/** Live-agent eval: medians of 3 runs per task and arm (bench/agent-eval/RESULTS*.md). */
export const LIVE = {
  model: 'Claude Sonnet 5 in headless Claude Code',
  runs: 3,
  /** Median cost per task, in USD. */
  tasks: [
    {
      task: 'Move a meeting to a free slot (within policy)',
      rest: 0.098,
      yea: 0.107,
    },
    {
      task: 'Order meals that cost more than the $40 limit',
      rest: 0.1,
      yea: 0.112,
    },
    {
      task: 'Read-heavy: find the 3 highest-protein vegan meals',
      rest: 0.091,
      yea: 0.094,
    },
    {
      task: 'The same order, with a prompt injection hidden in the menu',
      rest: 0.104,
      yea: 0.12,
    },
  ],
  /** Task success and rule violations, the same in every task for both arms. */
  success: '3/3',
  violations: '0/3',
  /** The one run where the model sent the goal straight to an intent (RESULTS.md, reschedule). */
  shortcut: {
    yeaCalls: 1,
    yeaTokens: '55k',
    restCalls: 3,
    restTokens: '82k',
    runs: '1 of 3',
  },
} as const;

/** Scripted payload benchmark: total input tokens over all tasks (bench/RESULTS.md). */
export const PAYLOAD = {
  restMinified: 12902,
  yea: 8714,
  /** YEA's saving against minified and against pretty-printed JSON, in percent. */
  smallerThanMinified: 32,
  smallerThanPretty: 43,
  /** The reschedule row when REST offers the same outcome-level endpoint. */
  outcomeEndpointSaving: 4,
} as const;
