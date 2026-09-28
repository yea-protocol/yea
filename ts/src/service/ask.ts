/** The ASK verb: run a read-only capability and answer with its data. */
import { fit } from '../budget.js';
import { replyFrame } from '../frames.js';
import type { FinalReply, Request } from '../types.js';
import { validateParams } from '../validate.js';
import { unknownCapability } from './capabilities.js';
import { verifiedKey } from './replies.js';
import type { ServiceState } from './state.js';

export async function onAsk(
  state: Pick<ServiceState, 'asks' | 'intents' | 'authorizer' | 'handles'>,
  req: Request & { verb: 'ASK' },
  budget: number,
): Promise<FinalReply> {
  const def =
    state.asks.get(req.capability) ??
    unknownCapability(state, req.capability, 'ask');
  const params = req.params ?? {};

  validateParams(def.params, params);

  const auth = await state.authorizer.authorize(req, {
    verb: 'ASK',
    capability: req.capability,
    target: req.capability,
  });
  const data = await def.run({ params, principal: auth?.iss ?? null });

  return fit(
    replyFrame(req.id, 'ANSWER', { data: data ?? null }),
    budget,
    state.handles,
    verifiedKey(req),
  );
}
