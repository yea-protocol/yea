/**
 * The public API of `@yea-protocol/sdk`: the protocol core that runs anywhere
 * (client, service, grants, Lens, budgets, consent and job approval, the wire
 * types). Node transports, OpenAPI, the examples and the CLI are separate
 * entries (`/node`, `/openapi`, `/examples`, `/cli`).
 */

export {
  type HashedPlan,
  hashPlans,
  isReceiptId,
  type JobPlan,
  newReceiptId,
  type Policy,
  planHashOf,
  planPreimage,
  readTightening,
  type Tightening,
  type UndoOutcome,
  undoJob,
} from './approval.js';

export {
  type ApproveIO,
  type ApproveOutcome,
  approveConsentCode,
} from './approve.js';

export { consentCodeFor, outOfBand, signer } from './approvers.js';

export {
  type ApprovalAnswer,
  type ApprovalForm,
  type ApprovalState,
  CONSENT_TTL,
  type JobConsent,
  readJobConsent,
  signJobConsent,
} from './ask.js';

export { b64u } from './b64.js';

export {
  fit,
  type HandleStore,
  MemoryHandleStore,
  type Parked,
} from './budget.js';

export { canonical } from './canonical.js';

export {
  Client,
  type ClientOptions,
  http,
  type IntentResult,
  lines,
  local,
  type Transport,
  type WithLens,
} from './client.js';

export {
  consentCode,
  consentGrant,
  consentRecipient,
  decodeConsentCode,
} from './consent.js';

export {
  type Approver,
  type CommitReply,
  type ConsentAnswer,
  type ConsentAsk,
  type ConsentStore,
  checkProposal,
  consentRound,
  keyFingerprint,
  memoryConsents,
  type RoundClient,
  type RoundOptions,
  type RoundOutcome,
} from './consent-round.js';

export {
  type KeyPair,
  keyPair,
  proposalHash,
  sha256,
  sign,
  verify,
} from './crypto.js';

export { fail, fix, YeaError } from './errors.js';

export {
  type Caveat,
  type CheckContext,
  checkGrant,
  decodeGrant,
  delegateGrant,
  encodeGrant,
  type GrantCheck,
  type GrantInfo,
  inspectGrant,
  isPublicKey,
  issueGrant,
} from './grants.js';

export { fetchHandler } from './http.js';

export {
  type ConsentCodes,
  type ConsentCodesOutcome,
  type JobCall,
  type JobCallOutcome,
  type JobCallRetry,
  type JobTool,
  jobCall,
} from './job-call.js';

export {
  effectLine,
  est,
  fmtDuration,
  lean,
  lens,
  oneLine,
  safeEffectLine,
  scalar,
  untrustedLens,
} from './lens.js';

export {
  type Clarification,
  type CommitCtx,
  type Ctx,
  clarify,
  create,
  type Plan,
  remove,
  type ServiceOptions,
  send,
  update,
} from './plan.js';

export { checkProof, makeProof } from './proof.js';

export { atLeast, exceeds, isRisk } from './risk.js';

export { Service, service } from './service.js';

export {
  type ApprovalStore,
  isMemoryStore,
  type JobReceipt,
  type LedgerKey,
  MemoryStore,
  type Reservation,
} from './store.js';

export { clip, printable } from './text.js';

export { INSTRUCTIONS, TOOLS } from './tool-defs.js';

export * from './types.js';

export {
  exact,
  fmtQuantity,
  fmtUses,
  isUses,
  type Limit,
  type Quantity,
  quantity,
  spend,
  type Uses,
} from './uses.js';

export { unixNow } from './util.js';
