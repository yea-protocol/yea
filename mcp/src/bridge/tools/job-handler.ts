/**
 * The handler every job tool shares, per-capability or generic: it refuses any approval state,
 * checks the job's own fields (`goal`, `preview`, `proposal`), and runs the call (job.ts).
 */
import type {
  CallToolResult,
  ServerContext,
} from '@modelcontextprotocol/server';
import { errorResult, NOTHING_RAN, refused } from '../../result.js';
import type { Obj } from '../../util.js';
import type { Service } from '../greet.js';
import { runJobCall } from '../job.js';
import type { Bridge } from '../state.js';
import type { JobCall } from '../types.js';

/** Any approval state on a job call: the bridge mints none yet (TODO(#73)). */
const UNMINTED_STATE = `this approval state is invalid, expired or already used; ${NOTHING_RAN}. Call the tool again without it.`;

/** A call's capability, its params, and the job's own fields; or why the arguments are wrong. */
export type Picked =
  | { capability: string; params: Obj; fields: Obj }
  | { why: string };

/** The job's own fields, and everything else. */
export function split(args: Obj) {
  const { goal, preview, proposal, ...rest } = args;

  return { fields: { goal, preview, proposal }, rest };
}

/** The job's own fields, type-checked; or why they're wrong. */
function jobFields(
  f: Obj,
): Pick<JobCall, 'goal' | 'preview' | 'proposal'> | { why: string } {
  const { goal, preview, proposal } = f;

  if (goal !== undefined && typeof goal !== 'string') {
    return { why: 'goal must be a string' };
  }

  if (preview !== undefined && typeof preview !== 'boolean') {
    return { why: 'preview must be true or false' };
  }

  if (proposal !== undefined && typeof proposal !== 'string') {
    return { why: 'proposal must be a proposal id' };
  }

  return { goal, preview: preview === true, proposal };
}

/**
 * A job tool's handler. It never takes an approval state: the bridge mints none until
 * `--approve-here` (TODO(#73)), so any state is refused and never falls through to an INTENT.
 */
export function jobHandler(
  b: Bridge,
  base: { tool: string; svc: Service },
  pick: (args: Obj) => Picked,
) {
  return async (args: Obj, ctx: ServerContext): Promise<CallToolResult> => {
    if (ctx.mcpReq.requestState() !== undefined) {
      return errorResult([`✗ ${UNMINTED_STATE}`]);
    }

    const picked = pick(args);

    if ('why' in picked) {
      return refused(picked.why);
    }

    const fields = jobFields(picked.fields);

    if ('why' in fields) {
      return refused(fields.why);
    }

    return runJobCall(b, {
      ...base,
      capability: picked.capability,
      params: picked.params,
      ...fields,
    });
  };
}
