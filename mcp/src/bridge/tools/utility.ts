/**
 * The bridge's `yea_expand` and `yea_undo` (SPEC-bridge, "Read tools, expand and undo"): each
 * its spec, then its handler, over a known service the call names.
 */
import type { CallToolResult } from '@modelcontextprotocol/server';
import { printable } from '@yea-protocol/sdk';
import {
  errorResult,
  READ_ANNOTATIONS,
  UNDO_ANNOTATIONS,
} from '../../result.js';
import type { Obj } from '../../util.js';
import { answerResult } from '../calls.js';
import type { Service } from '../greet.js';
import { replyResult } from '../lens.js';
import type { Bridge } from '../state.js';
import type { ToolSpec } from '../types.js';
import { object, str } from './spec.js';

const isResult = (v: Service | CallToolResult): v is CallToolResult =>
  'content' in v;

/** The service a utility call names, or an error listing the ones there are. */
function serviceFor(
  services: Map<string, Service>,
  id: unknown,
): Service | CallToolResult {
  const svc = typeof id === 'string' ? services.get(id) : undefined;

  return (
    svc ??
    errorResult([
      `✗ unknown service ${printable(JSON.stringify(id) ?? '')}; known: ${[...services.keys()].map(printable).join(', ')}`,
    ])
  );
}

/** A utility's handler that needs a known service and one string field. */
function withService(
  services: Map<string, Service>,
  field: string,
  run: (svc: Service, v: string) => Promise<CallToolResult>,
) {
  return async (args: Obj) => {
    const svc = serviceFor(services, args.service);

    if (isResult(svc)) {
      return svc;
    }

    return typeof args[field] === 'string'
      ? run(svc, args[field])
      : errorResult([`✗ ${field} must be a string`]);
  };
}

/** `yea_expand`, fetching what a read elided. */
export const expandTool = (
  b: Bridge,
  services: Map<string, Service>,
): ToolSpec => ({
  name: 'yea_expand',
  description:
    'Fetch the rest of an elided result, by its handle (EXPAND h_…).',
  schema: object(
    { service: str('The service id.'), handle: str('The handle, h_….') },
    ['service', 'handle'],
  ),
  annotations: READ_ANNOTATIONS,
  meta: {},
  run: withService(services, 'handle', (svc, handle) =>
    expandCall(svc, { handle, budget: b.budget }),
  ),
});

/** `yea_expand`: the rest of an elided result. The service binds handles to the agent's key. */
async function expandCall(
  svc: Service,
  o: { handle: string; budget: number },
): Promise<CallToolResult> {
  return answerResult(
    svc,
    await svc.client.expand(o.handle, { budget: o.budget }),
  );
}

/** `yea_undo`, undoing a receipt. */
export const undoTool = (services: Map<string, Service>): ToolSpec => ({
  name: 'yea_undo',
  description: 'Undo a receipt within its undo window.',
  schema: object(
    {
      service: str('The service id.'),
      receipt: str('The receipt id, r_….'),
    },
    ['service', 'receipt'],
  ),
  annotations: UNDO_ANNOTATIONS,
  meta: {},
  run: withService(services, 'receipt', undoCall),
});

/** `yea_undo`: the service checks the window and the principal. */
async function undoCall(
  svc: Service,
  receipt: string,
): Promise<CallToolResult> {
  const r = await svc.client.undo(receipt);

  return replyResult(
    r,
    r.kind === 'RECEIPT' ? { receipt: r.receipt } : undefined,
  );
}
