/** Wire types for YEA v1. See SPEC.md. */
import type { Uses } from './uses.js';

export type Verb = 'HELLO' | 'ASK' | 'INTENT' | 'COMMIT' | 'UNDO' | 'EXPAND';

export type Kind =
  | 'BRIEF'
  | 'ANSWER'
  | 'PROPOSALS'
  | 'CLARIFY'
  | 'RECEIPT'
  | 'ERROR'
  | 'EVENT';

export type Risk = 'low' | 'medium' | 'high';

export type EffectOp = 'create' | 'update' | 'delete' | 'send' | 'other';

export type Scalar = string | number | boolean | null;

export type ErrorCode =
  | 'bad_frame'
  | 'unknown_capability'
  | 'invalid_params'
  | 'unauthorized'
  | 'forbidden'
  | 'consent_required'
  | 'not_found'
  | 'expired'
  | 'conflict'
  | 'limit'
  | 'unavailable'
  | 'internal';

export interface Effect {
  op: EffectOp;
  target: string;
  field?: string;
  from?: Scalar;
  to?: Scalar;
  detail?: string;
}

export interface Proposal {
  id: string;
  capability: string;
  summary: string;
  effects: Effect[];
  uses?: Uses;
  risk: Risk;
  undo: { window: number } | null;
  expires: number;
  hash: string;
  data?: unknown;
}

export interface Receipt {
  id: string;
  proposal: string;
  capability: string;
  summary: string;
  at: number;
  effects: Effect[];
  uses?: Uses;
  undo: { until: number } | null;
  undoes?: string;
  result?: unknown;
}

export interface More {
  handle: string;
  path: string;
  remaining: number;
  est: number;
}

export interface CapabilityInfo {
  name: string;
  kind: 'ask' | 'intent';
  summary: string;
  params?: ParamSchema;
  risk?: Risk;
}

/** Compact param schema (SPEC §4.1.1): name (suffix `?` = optional) → type string or nested schema. */
export interface ParamSchema {
  [name: string]: string | ParamSchema | [ParamSchema];
}

export interface Proof {
  key: string;
  ts: number;
  sig: string;
}

export interface Fix {
  say: string;
  params?: Record<string, unknown>;
}

export interface ConsentRequest {
  proposal: string;
  hash: string;
  service: string;
  capability: string;
  principal: string;
  summary: string;
  expires: number;
}

interface FrameBase {
  yea: 1;
  id: string;
}

export interface RequestBase extends FrameBase {
  verb: Verb;
  budget?: number;
  grants?: string[];
  proof?: Proof;
}

export interface Hello extends RequestBase {
  verb: 'HELLO';
  agent?: { name?: string; key?: string };
}

export interface Ask extends RequestBase {
  verb: 'ASK';
  capability: string;
  params?: Record<string, unknown>;
}

export interface Intent extends RequestBase {
  verb: 'INTENT';
  capability: string;
  params?: Record<string, unknown>;
  goal?: string;
  auto?: boolean;
}

export interface Commit extends RequestBase {
  verb: 'COMMIT';
  proposal: string;
  hash: string;
}

export interface Undo extends RequestBase {
  verb: 'UNDO';
  receipt: string;
}

export interface Expand extends RequestBase {
  verb: 'EXPAND';
  handle: string;
}

export type Request = Hello | Ask | Intent | Commit | Undo | Expand;

interface ReplyBase extends FrameBase {
  re: string;
  lens?: string;
}

export interface Brief extends ReplyBase {
  kind: 'BRIEF';
  service: { id: string; name: string; summary: string };
  capabilities: CapabilityInfo[];
  more?: More[];
}

export interface Answer extends ReplyBase {
  kind: 'ANSWER';
  data: unknown;
  more?: More[];
}

export interface Proposals extends ReplyBase {
  kind: 'PROPOSALS';
  proposals: Proposal[];
  more?: More[];
}

export interface Clarify extends ReplyBase {
  kind: 'CLARIFY';
  question: string;
  options: { label: string; params: Record<string, unknown> }[];
}

export interface ReceiptReply extends ReplyBase {
  kind: 'RECEIPT';
  receipt: Receipt;
  replay?: boolean;
  auto?: boolean;
}

export interface ErrorReply extends ReplyBase {
  kind: 'ERROR';
  code: ErrorCode;
  message: string;
  fix?: Fix[];
  need?: unknown[];
  consent?: ConsentRequest;
  retry?: number | null;
}

export interface Event extends ReplyBase {
  kind: 'EVENT';
  message: string;
  progress?: number;
  data?: unknown;
}

export type Reply =
  | Brief
  | Answer
  | Proposals
  | Clarify
  | ReceiptReply
  | ErrorReply
  | Event;

export type FinalReply = Exclude<Reply, Event>;
export type Frame = Request | Reply;
