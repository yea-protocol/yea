/** A remote tool before it's named, and the `_meta` that ties it to its service and capability. */
import type { Service } from '../greet.js';
import type { ToolSpec } from '../types.js';

export type Unnamed = Omit<ToolSpec, 'name'>;

export const meta = (svc: Service, capability?: string) => ({
  'dev.yea/service': svc.id,
  ...(capability === undefined ? {} : { 'dev.yea/capability': capability }),
});
