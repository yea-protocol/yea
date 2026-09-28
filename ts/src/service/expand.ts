/** The EXPAND verb (SPEC §4.6): hand back the rest of a reply parked behind a handle. */
import { fit } from '../budget.js';
import { fix, YeaError } from '../errors.js';
import { replyFrame } from '../frames.js';
import { checkProof } from '../proof.js';
import type { FinalReply, Request } from '../types.js';
import type { ServiceState } from './state.js';

export async function onExpand(
  state: Pick<ServiceState, 'id' | 'opts' | 'handles' | 'now'>,
  req: Request & { verb: 'EXPAND' },
  budget: number,
): Promise<FinalReply> {
  const parked = state.handles.get(req.handle);

  if (!parked) {
    throw new YeaError(
      'expired',
      `handle ${JSON.stringify(req.handle)} is unknown or expired`,
      { fix: [fix('repeat the original request')] },
    );
  }

  // Handles from authenticated replies expand only for the same holder key (SPEC §4.6).
  if (parked.owner) {
    const err = await checkProof(
      req.proof,
      { aud: state.id, verb: 'EXPAND', target: req.handle },
      state.now(),
    );

    if (err || req.proof?.key !== parked.owner) {
      throw new YeaError(
        'unauthorized',
        'this handle belongs to another agent',
        {
          fix: [
            fix('expand it with the same key that made the original request'),
          ],
        },
      );
    }
  } else if (state.opts.requireGrants) {
    throw new YeaError(
      'unauthorized',
      'EXPAND needs a grant from your principal',
    );
  }

  const data =
    parked.kind === 'array' ? { items: parked.items } : { text: parked.text };

  return fit(
    replyFrame(req.id, 'ANSWER', { data }),
    budget,
    state.handles,
    parked.owner ?? null,
  );
}
