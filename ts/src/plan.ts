/**
 * What a service author writes: the service options, the contexts handlers get, the
 * plans an intent returns, and the effect builders plans use. Service (service.ts) runs them.
 */
import type { HandleStore } from './budget.js';
import type { Effect, ParamSchema, Risk } from './types.js';
import type { Uses } from './uses.js';

export interface ServiceOptions {
  id: string;
  name: string;
  summary: string;
  /** Principal public keys allowed to authorize actions, or a predicate. */
  trust?: string[] | ((principal: string) => boolean);
  /** Require grants for ASK/INTENT too (they are always required for COMMIT/UNDO). */
  requireGrants?: boolean;
  defaultBudget?: number;
  /** Default seconds a proposal stays committable. */
  proposalTtl?: number;
  handles?: HandleStore;
  now?: () => number;
  /** Called for unexpected handler exceptions, and for EVENTs a transport could not send (they are dropped). */
  onError?: (err: unknown) => void;
}

export interface Ctx {
  /** Already checked against the capability's `params` schema, so handlers may read fields directly. */
  // biome-ignore lint/suspicious/noExplicitAny: public handler API; `unknown` would force casts in every existing handler
  params: Record<string, any>;
  goal?: string;
  /** The principal (public key) on whose behalf the agent acts, if it presented a valid grant. */
  principal: string | null;
}

export interface CommitCtx {
  principal: string;
  /** Stream progress to the agent as EVENT frames. */
  progress(message: string, progress?: number, data?: unknown): void;
}

/** What an intent handler returns for each way it could satisfy the intent. */
export interface Plan<R = unknown> {
  summary: string;
  effects: Effect[];
  /** What committing uses up (SPEC §5.1), e.g. `{ spend: spend('22.87', 'USD') }`. */
  uses?: Uses;
  risk?: Risk;
  /** Seconds this proposal can be committed for (default: service proposalTtl). */
  expiresIn?: number;
  data?: unknown;
  /** Perform the effects. Only ever called on COMMIT, at most once. */
  apply(ctx: CommitCtx): R | Promise<R>;
  /** Reverse the effects. If present, the proposal is undoable for `undoWindow` seconds. */
  revert?(ctx: CommitCtx & { result: R }): unknown;
  undoWindow?: number;
}

export interface Clarification {
  clarify: {
    question: string;
    options: { label: string; params: Record<string, unknown> }[];
  };
}

export const clarify = (
  question: string,
  options: { label: string; params: Record<string, unknown> }[],
): Clarification => ({ clarify: { question, options } });

export interface AskDef {
  summary: string;
  params?: ParamSchema;
  run(ctx: Ctx): unknown;
}

export interface IntentDef {
  summary: string;
  params?: ParamSchema;
  risk?: Risk;
  plan(
    ctx: Ctx,
  ): Plan | Plan[] | Clarification | Promise<Plan | Plan[] | Clarification>;
}

// ---- effect helpers ----
export const create = (target: string, detail?: string): Effect => ({
  op: 'create',
  target,
  ...(detail ? { detail } : {}),
});

// biome-ignore lint/complexity/useMaxParams: public effect helper; its positional signature is published API
export const update = (
  target: string,
  field: string,
  from: Effect['from'],
  to: Effect['to'],
  detail?: string,
): Effect => ({
  op: 'update',
  target,
  field,
  from,
  to,
  ...(detail ? { detail } : {}),
});

export const remove = (target: string, detail?: string): Effect => ({
  op: 'delete',
  target,
  ...(detail ? { detail } : {}),
});

export const send = (target: string, detail?: string): Effect => ({
  op: 'send',
  target,
  ...(detail ? { detail } : {}),
});
