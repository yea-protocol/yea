/**
 * The two generic tools a large service gets (SPEC-bridge, "Tools"): `<service>_ask` and
 * `<service>_intent`, each its spec, then its handler, which checks `capability` against the
 * service's own list.
 */
import {
  errorResult,
  JOB_ANNOTATIONS,
  READ_ANNOTATIONS,
} from '../../result.js';
import { isObject, type Obj } from '../../util.js';
import { readCall } from '../calls.js';
import type { Service } from '../greet.js';
import { clip } from '../lens.js';
import { genericSchema } from '../params.js';
import type { Bridge } from '../state.js';
import { jobHandler, type Picked, split } from './job-handler.js';
import { meta, type Unnamed } from './spec.js';

/** Past this many capabilities, a service gets two generic tools instead (decision 1). */
const GENERIC_PAST = 25;

export type ToolMode = 'auto' | 'generic' | 'per-capability';

/** Whether a service gets the two generic tools. */
export const isGeneric = (svc: Service, mode: ToolMode) =>
  mode === 'generic' ||
  (mode === 'auto' && svc.capabilities.length > GENERIC_PAST);

/** A generic tool's `capability` and `params`, checked against the service's own list. */
function genericPick(svc: Service, kind: 'ask' | 'intent') {
  return (args: Obj): Picked => {
    const { fields, rest } = split(args);
    const { capability, params } = rest;
    const known = svc.capabilities.some(
      (c) => c.name === capability && c.kind === kind,
    );

    if (typeof capability !== 'string' || !known) {
      return {
        why: `${clip(String(capability), 100)} is not one of ${clip(svc.id, 100)}'s ${kind} capabilities`,
      };
    }

    if (params !== undefined && !isObject(params)) {
      return { why: 'params must be an object' };
    }

    return { capability, params: params ?? {}, fields };
  };
}

/** `<service>_ask` or `<service>_intent`, taking `{ capability, params, … }`. */
export function genericTool(b: Bridge, svc: Service, kind: 'ask' | 'intent') {
  const pick = genericPick(svc, kind);
  const description = `${kind === 'ask' ? 'Read from' : 'Do something at'} ${clip(svc.name, 100)} (${clip(svc.id, 100)}): pass one of its ${kind} capabilities (listed in the instructions) and its params.`;

  if (kind === 'ask') {
    return (): Unnamed => ({
      description,
      schema: genericSchema(kind),
      annotations: READ_ANNOTATIONS,
      meta: meta(svc),
      run: async (args) => {
        const p = pick(args);

        return 'why' in p
          ? errorResult([`✗ ${p.why}`])
          : readCall(svc, {
              capability: p.capability,
              params: p.params,
              budget: b.budget,
            });
      },
    });
  }

  return (name: string): Unnamed => ({
    description,
    schema: genericSchema(kind),
    annotations: JOB_ANNOTATIONS,
    meta: meta(svc),
    run: jobHandler(b, { tool: name, svc }, pick),
  });
}
