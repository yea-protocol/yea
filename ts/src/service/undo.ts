/** The UNDO verb (SPEC §4.5): the commit ledger reverts the receipt's plan once, inside its undo window. */
import { fit } from '../budget.js';
import type { Event, FinalReply } from '../types.js';
import type { ServiceState } from './state.js';
import type { VerifiedUndo } from './verified-request.js';

/** `req` names an undoable receipt, under a grant from the principal who committed it. */
export async function onUndo(
  state: Pick<ServiceState, 'ledger' | 'handles'>,
  req: VerifiedUndo,
  emit: (e: Event) => void,
): Promise<FinalReply> {
  const out = await state.ledger.undo(req, emit);

  return out.kind === 'RECEIPT'
    ? fit(out, req.budget, state.handles, req.holder)
    : out;
}
