/** Reading a request's `grants` (SPEC §3): a dense list of grant tokens, or none. */
import { YeaError } from '../errors.js';
import type { Request } from '../types.js';

const badGrants = () =>
  new YeaError('bad_frame', '`grants` must be a list of strings');

/**
 * A request's grants (SPEC §3). Only a missing, null or empty `grants` is no grants; anything
 * else must be a list of strings. The loop reads every index, so a hole in a sparse array (which
 * `every` would skip) is refused too.
 */
export function grantsOf(req: Request): string[] {
  const grants: unknown = req.grants;

  if (grants === undefined || grants === null) {
    return [];
  }

  if (!Array.isArray(grants)) {
    throw badGrants();
  }

  for (let i = 0; i < grants.length; i++) {
    if (typeof grants[i] !== 'string') {
      throw badGrants();
    }
  }

  return grants;
}
