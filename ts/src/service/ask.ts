/** The ASK verb: run a read-only capability and answer with its data. */
import { fit } from '../budget.js';
import { replyFrame } from '../frames.js';
import type { FinalReply } from '../types.js';
import type { ServiceState } from './state.js';
import type { VerifiedAsk } from './verified-request.js';

export async function onAsk(
  state: Pick<ServiceState, 'handles'>,
  req: VerifiedAsk,
): Promise<FinalReply> {
  const data = await req.def.run({
    params: req.params,
    principal: req.principal,
  });

  return fit(
    replyFrame(req.id, 'ANSWER', { data: data ?? null }),
    req.budget,
    state.handles,
    req.holder,
  );
}
