/**
 * Shapes the bridge's modules share: a tool as the server factory registers it, and one job
 * call. They live apart so the modules that use them never import each other in a cycle.
 * `Bridge` stays in job.ts: it names `ConsentStore`, so here it would make a type-only cycle
 * with consent.ts.
 */
import type {
  CallToolResult,
  ServerContext,
  ToolAnnotations,
} from '@modelcontextprotocol/server';
import type { Obj } from '../util.js';
import type { Service } from './greet.js';

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
