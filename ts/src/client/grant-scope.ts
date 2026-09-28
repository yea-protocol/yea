/** Which grants a client may send a service: a grant's `svc` caveat, if it has one, must list it. */
import { type Caveat, decodeGrant } from '../grants.js';

const hasSvc = (c: Caveat): c is { svc: string[] } =>
  Boolean((c as { svc?: unknown }).svc);

/** Whether a grant may be sent to `aud`: its `svc` caveat, if any, lists it. Undecodable grants may not. */
export function grantCovers(token: string, aud: string): boolean {
  try {
    const scope = decodeGrant(token)
      .flatMap((b) => b.p.caveats)
      .find(hasSvc);

    return !scope || scope.svc.includes(aud);
  } catch {
    return false;
  }
}
