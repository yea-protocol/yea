/**
 * The protocol states the landing walks through, in order, with the copy for each. The
 * artifact each one shows comes from the recorded exchange (exchange.ts).
 */

export type StateKey = 'intent' | 'proposal' | 'policy' | 'consent' | 'receipt';

export interface StateStep {
  key: StateKey;
  title: string;
  body: string;
}

export const STATES: readonly StateStep[] = [
  {
    key: 'intent',
    title: 'The agent says what it wants',
    body: 'It sends an intent: the outcome, not the endpoints to reach it. The service answers with proposals, and nothing has happened yet.',
  },
  {
    key: 'proposal',
    title: 'The service proposes',
    body: 'Each proposal lists its effects up front: what changes, what it uses, its risk and its undo window. Its hash binds any commit to exactly what was shown.',
  },
  {
    key: 'policy',
    title: "The person's policy decides",
    body: 'The person signs it once, as a grant the agent presents with each request. Inside it, a commit goes through in one round trip. Grants are Ed25519 capability chains with limits, expiry, scopes and risk ceilings, verified offline and narrowed for sub-agents.',
  },
  {
    key: 'consent',
    title: 'Past the policy, the person says yes',
    body: "Anything over a limit or irreversible stops, and the service asks. The person approves that exact proposal by signing its hash, as the slip above does. The agent can't sign it for them.",
  },
  {
    key: 'receipt',
    title: 'A receipt, and a way back',
    body: 'A commit returns a receipt with its undo window. UNDO is a verb, so going back is part of the protocol, not an afterthought.',
  },
];

/** What else the protocol does for the model, after the five states. */
export const FOR_MODELS: readonly (readonly [string, string])[] = [
  [
    'Budgets',
    'Every request carries a token budget. Replies fit it and leave EXPAND handles for the rest.',
  ],
  [
    'Errors that teach',
    'Errors say how to fix the request, with patches a model can apply. Ambiguity gets CLARIFY, not an error.',
  ],
  [
    'Lens',
    'Replies come in Lens, a compact text format written for models, byte-identical across implementations.',
  ],
];
