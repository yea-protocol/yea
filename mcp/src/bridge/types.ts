/**
 * Shapes the bridge's modules share: a tool as the server factory registers it, one job call,
 * and the tool mode that picks a service's tools. They live apart so the modules that use them
 * never import each other in a cycle.
 * What every call shares, `Bridge`, lives in state.ts.
 */
import type {
  CallToolResult,
  ServerContext,
  ToolAnnotations,
} from '@modelcontextprotocol/server';
import type { Obj } from '../util.js';
import type { Service } from './greet.js';

/** How a service's capabilities become tools: `auto` is generic past 25 capabilities. */
export type ToolMode = 'auto' | 'generic' | 'per-capability';

/** A tool as the server factory registers it. */
export interface ToolSpec {
  name: string;
  description: string;
  schema: Obj;
  annotations: ToolAnnotations;
  meta: Obj;
  run(args: Obj, ctx: ServerContext): Promise<CallToolResult>;
}

/** One job call, its arguments already split and type-checked. */
export interface JobCall {
  tool: string;
  svc: Service;
  capability: string;
  params: Obj;
  goal?: string;
  preview: boolean;
  proposal?: string;
}
