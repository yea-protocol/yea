/**
 * The utility tools as MCP tool specs (SPEC-bridge, "Read tools, expand and undo", and
 * `yea_consent`): `yea_consent`, `yea_expand` and `yea_undo`, over the handlers in calls.ts.
 */
import type { CallToolResult } from '@modelcontextprotocol/server';
import { printable } from '@yea-protocol/sdk';
import { errorResult, READ_ANNOTATIONS, UNDO_ANNOTATIONS } from '../result.js';
import type { Obj } from '../util.js';
import { consentCall, expandCall, undoCall } from './calls.js';
import type { Service } from './greet.js';
import type { Bridge } from './job.js';
import type { ToolSpec } from './types.js';

const str = (description: string) => ({ type: 'string', description });

const object = (properties: Obj, required: string[]) => ({
  type: 'object',
  properties,
  required,
});

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

const isResult = (v: Service | CallToolResult): v is CallToolResult =>
  'content' in v;

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

/** `yea_consent`: only saves a consent `yea approve` signed; it signs and commits nothing. */
const consentTool = (b: Bridge, services: Map<string, Service>): ToolSpec => ({
  name: 'yea_consent',
  description:
    'Hand back a consent the user signed with `yea approve` (a pg1. token they paste to you). It is only saved; then call the same tool again to commit.',
  schema: object({ token: str('The pg1. consent `yea approve` printed.') }, [
    'token',
  ]),
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
  meta: {},
  run: (args) =>
    consentCall(
      { pending: b.pending, consents: b.consents, services, now: b.now() },
      args.token,
    ),
});

/** `yea_consent`, `yea_expand` and `yea_undo`. */
export function utilityTools(
  b: Bridge,
  services: Map<string, Service>,
): ToolSpec[] {
  return [
    consentTool(b, services),
    {
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
    },
    {
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
    },
  ];
}
