/**
 * The approval state's round trip through the client (SPEC-mcp-ts, "How a call runs", steps 5, 8
 * and 10): the retry a request carries (our state, verified by the codec, and the person's
 * answer), and the `inputRequired` result that asks, with the state sealed.
 */
import {
  type InputRequiredResult,
  inputRequired,
  inputResponse,
  type ServerContext,
} from '@modelcontextprotocol/server';
import type {
  ApprovalAnswer,
  JobCallOutcome,
  JobCallRetry,
} from '@yea-protocol/sdk';
import { isObject } from '../util.js';
import type { Call } from './context.js';

/** The person's answer, as the session judges it; a missing one is not an approval. */
function answerOf(ctx: ServerContext): ApprovalAnswer {
  const view = inputResponse(ctx.mcpReq.inputResponses, 'yea');

  return view.kind === 'elicit'
    ? {
        action: view.action,
        ...(view.content ? { content: view.content } : {}),
      }
    : { action: 'decline' };
}

/**
 * Step 5: a first call (undefined), or a retry carrying our state and the answer. Anything else
 * throws, and the call is refused.
 */
export function retryOf(ctx: ServerContext): JobCallRetry | undefined {
  const state: unknown = ctx.mcpReq.requestState();

  if (state === undefined) {
    return undefined;
  }

  if (typeof state === 'string') {
    throw new Error(
      'requestState was not verified: pass approvals.serverOptions() to new McpServer',
    );
  }

  if (!isObject(state) || !Object.hasOwn(state, 'yea')) {
    throw new Error(
      "requestState belongs to something else, not this job's approval",
    );
  }

  return { state: state.yea, answer: answerOf(ctx) };
}

/** Step 8: the form, and the session's state sealed by the codec for the retry. */
export async function askResult(
  call: Call,
  ask: Extract<JobCallOutcome, { kind: 'ask' }>,
): Promise<InputRequiredResult> {
  return inputRequired({
    inputRequests: {
      yea: inputRequired.elicit({
        message: ask.form.message,
        requestedSchema: ask.form.requestedSchema as never,
      }),
    },
    requestState: await call.y.codec.mint({ yea: ask.state }, call.ctx),
  });
}
