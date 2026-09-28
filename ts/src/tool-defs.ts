/**
 * The four generic tools `yea test-drive` gives a model, and their instructions. Kept apart from
 * tools.ts (which reads ~/.yea) so the SDK root can export them and stay runtime-neutral;
 * `bench/run.ts` measures them.
 */

const str = { type: 'string' };
const obj = (properties: Record<string, unknown>, required: string[]) => ({
  type: 'object',
  properties,
  required,
});

export const INSTRUCTIONS =
  "YEA acts for the user under their signed policy. To do something, call yea_intent with the user's goal (names, days are fine: no lookups needed) " +
  'and auto:true if they asked for exactly this; it finishes in one call when the policy allows. yea_ask is for questions. If approval is needed, tell the user.\n\n';

/** The generic tools' definitions, as MCP and the Claude API take them. */
export const TOOLS = [
  {
    name: 'yea_ask',
    description:
      'Read (never changes anything). Pass `handle` to expand an elided result.',
    inputSchema: obj(
      {
        service: str,
        capability: str,
        params: { type: 'object' },
        handle: str,
        budget: { type: 'integer' },
      },
      ['service'],
    ),
  },
  {
    name: 'yea_intent',
    description:
      "Do something: the user's goal as params (names, days are fine). auto:true finishes now if their policy allows; else returns proposals (effects, uses, risk, undo) or a question.",
    inputSchema: obj(
      {
        service: str,
        capability: str,
        params: { type: 'object' },
        goal: str,
        auto: { type: 'boolean' },
        budget: { type: 'integer' },
      },
      ['service', 'capability'],
    ),
  },
  {
    name: 'yea_commit',
    description:
      'Execute a proposal by id, exactly as shown. Only what the user wants.',
    inputSchema: obj({ service: str, proposal: str }, ['service', 'proposal']),
  },
  {
    name: 'yea_undo',
    description: 'Undo a receipt within its undo window.',
    inputSchema: obj({ service: str, receipt: str }, ['service', 'receipt']),
  },
];
