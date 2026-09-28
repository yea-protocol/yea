/**
 * A per-capability tool (SPEC-bridge, "Tools"): its spec (description, schema, annotations),
 * then its handler, a read for an `ask` capability and a job for an `intent` one.
 */
import type { CapabilityInfo } from '@yea-protocol/sdk';
import { JOB_ANNOTATIONS, READ_ANNOTATIONS } from '../../result.js';
import { warnOnce } from '../../util.js';
import { readCall } from '../calls.js';
import type { Service } from '../greet.js';
import { clip } from '../lens.js';
import {
  badParamNames,
  objectSchema,
  reservedParams,
  withJobFields,
} from '../params.js';
import type { Bridge } from '../state.js';
import { jobHandler, split } from './job-handler.js';
import { meta, type Unnamed } from './spec.js';

/** The description a model sees: the service's summary, one line, and where it runs. */
const describe = (svc: Service, cap: CapabilityInfo) =>
  `${clip(cap.summary || cap.name)} (${clip(cap.name, 100)} at ${clip(svc.id, 100)})`;

/** Why a capability's tool can't be built from its params, or null. */
function paramProblem(cap: CapabilityInfo): string | null {
  const bad = badParamNames(cap.params);

  if (bad.length) {
    return `its param name ${clip(bad.join(', '), 100)} isn't [a-zA-Z0-9_.-]{1,64}, which some model APIs require`;
  }

  const reserved = cap.kind === 'intent' ? reservedParams(cap.params) : [];

  return reserved.length
    ? `its param ${reserved.join(', ')} would shadow the bridge's own field`
    : null;
}

/** One capability's tool, or null (said on stderr) when its params can't be served. */
export function capabilityTool(
  b: Bridge,
  svc: Service,
  cap: CapabilityInfo,
): ((name: string) => Unnamed) | null {
  const problem = paramProblem(cap);

  if (problem) {
    warnOnce(
      `not serving ${clip(svc.id, 100)}/${clip(cap.name, 100)}: ${problem}`,
    );

    return null;
  }

  const schema = objectSchema(cap.params);

  if (cap.kind === 'ask') {
    return () => ({
      description: describe(svc, cap),
      schema,
      annotations: READ_ANNOTATIONS,
      meta: meta(svc, cap.name),
      run: (args) =>
        readCall(svc, { capability: cap.name, params: args, budget: b.budget }),
    });
  }

  return (name) => ({
    description: describe(svc, cap),
    schema: withJobFields(schema),
    annotations: JOB_ANNOTATIONS,
    meta: meta(svc, cap.name),
    run: jobHandler(b, { tool: name, svc }, (args) => {
      const { fields, rest } = split(args);

      return { capability: cap.name, params: rest, fields };
    }),
  });
}
