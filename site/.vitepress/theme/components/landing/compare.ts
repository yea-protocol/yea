/** The comparison table: YEA against REST/HTTP APIs and MCP, one row per concern. */

export const COMPARE_COLUMNS = ['REST / HTTP APIs', 'MCP', 'YEA'] as const;

export const COMPARE_ROWS: readonly (readonly [
  string,
  string,
  string,
  string,
])[] = [
  [
    'Unit of interaction',
    'resource (CRUD)',
    'tool call, usually wrapping an endpoint',
    'intent → proposal → commit',
  ],
  [
    'Preview before side effects',
    'rare, per API (dry-run flags)',
    'annotations such as destructiveHint, as hints; no effect preview',
    'effects, uses, risk and undo on every proposal, bound by hash',
  ],
  [
    'Undo',
    'per API, if at all',
    'not in the protocol',
    'a verb, with declared windows',
  ],
  [
    'Delegation',
    'API keys, OAuth scopes',
    'OAuth at the transport',
    'attenuable capability chains with limits and risk ceilings, verified offline',
  ],
  [
    'Human approval',
    'app-specific',
    'elicitation, not bound to an action',
    'a consent grant signed over the exact proposal hash',
  ],
  [
    'Context budget',
    'pagination, field selection',
    'list pagination',
    'every reply fits the budget, with EXPAND for the rest',
  ],
  [
    'Model-facing format',
    'JSON',
    'text or structured content, per server',
    'Lens: canonical and byte-identical across implementations',
  ],
  [
    'Errors',
    'status codes, RFC 9457',
    'JSON-RPC codes, isError and free text',
    'machine-applicable fixes, plus CLARIFY',
  ],
];
