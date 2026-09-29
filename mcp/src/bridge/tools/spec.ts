/**
 * The shape of a bridge tool's spec: a remote tool before it's named, the `_meta` that ties it
 * to its service and capability, and the schema pieces the utility tools are written in.
 */
import type { Obj } from '../../util.js';
import type { Service } from '../greet.js';
import type { ToolSpec } from '../types.js';

export type Unnamed = Omit<ToolSpec, 'name'>;

export const meta = (svc: Service, capability?: string) => ({
  'dev.yea/service': svc.id,
  ...(capability === undefined ? {} : { 'dev.yea/capability': capability }),
});

/** A string field of a utility tool's schema. */
export const str = (description: string) => ({ type: 'string', description });

/** A utility tool's input schema. */
export const object = (properties: Obj, required: string[]) => ({
  type: 'object',
  properties,
  required,
});
