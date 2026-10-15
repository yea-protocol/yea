/** The COMMIT verb (SPEC §4.4): the commit ledger commits the proposal once; repeats get the original outcome. */
import { fit } from '../budget.js';
import type { Event, FinalReply } from '../types.js';
import type { ServiceState } from './state.js';
import type { VerifiedCommit } from './verified-request.js';

/** `req` comes from the proposal's requester, under a grant from its principal. */
export async function onCommit(
  state: Pick<ServiceState, 'ledger' | 'handles'>,
  req: VerifiedCommit,
  emit: (e: Event) => void,
): Promise<FinalReply> {
  const out = await state.ledger.commit(req, emit);

  return out.kind === 'RECEIPT'
    ? fit(out, req.budget, state.handles, req.holder)
    : out;
}
