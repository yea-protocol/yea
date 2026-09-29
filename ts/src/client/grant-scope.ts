/** Which grants a client may send a service: a grant's `svc` caveat, if it has one, must list it. */
import { type Caveat, decodeGrant } from '../grants.js';

const hasSvc = (c: Caveat): c is Caveat & { svc: unknown } =>
  typeof c === 'object' && c !== null && Object.hasOwn(c, 'svc');

/**
 * Whether a grant may be sent to `aud`: every `svc` caveat in every block lists it, as the
 * service checks. A `svc` that isn't a list (SPEC §6) covers nothing, as in Python; undecodable
 * grants may not be sent.
 */
export function grantCovers(token: string, aud: string): boolean {
  try {
    return decodeGrant(token)
      .flatMap((b) => b.p.caveats)
      .filter(hasSvc)
      .every((c) => Array.isArray(c.svc) && c.svc.includes(aud));
  } catch {
    return false;
  }
}
