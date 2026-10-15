/** The EXPAND verb (SPEC §4.6): hand back the rest of a reply parked behind a handle. */
import { fit } from '../budget.js';
import { replyFrame } from '../frames.js';
import type { FinalReply } from '../types.js';
import type { ServiceState } from './state.js';
import type { VerifiedExpand } from './verified-request.js';

export function onExpand(
  state: Pick<ServiceState, 'handles'>,
  req: VerifiedExpand,
): FinalReply {
  const { parked } = req;
  const data =
    parked.kind === 'array' ? { items: parked.items } : { text: parked.text };

  return fit(
    replyFrame(req.id, 'ANSWER', { data }),
    req.budget,
    state.handles,
    req.owner,
  );
}
