/**
 * The public API of `@yea-protocol/sdk`: the protocol core that runs anywhere
 * (client, service, grants, Lens, budgets, consent and job approval, the wire
 * types). Node transports, OpenAPI, the examples and the CLI are separate
 * entries (`/node`, `/openapi`, `/examples`, `/cli`).
 */

export {
  assertIntegers,
  checkJobConsent,
  type Decision,
  decide,
  type HashedPlan,
  hashPlans,
  isReceiptId,
  type JobPlan,
  newReceiptId,
  type Policy,
  planHashOf,
  planPreimage,
  type ReserveFor,
  readTightening,
  reserveAll,
  type Tightening,
  type UndoOutcome,
  undoJob,
} from './approval.js';

export {
  type ApproveIO,
  type ApproveOutcome,
  approveConsentCode,
  checkProposal,
  keyFingerprint,
} from './approve.js';

export {
  type ApprovalAnswer,
  type ApprovalForm,
  type ApprovalState,
  buildForm,
  CONSENT_TTL,
  checkState,
  DEFAULT_PHRASE,
  inputHashOf,
  type JobConsent,
  type JudgeContext,
  jobConsentCode,
  judgeAnswer,
  MAX_ROUNDS,
  newState,
  type PhraseFor,
  phraseMatches,
  readJobConsent,
  STATE_TTL,
  signJobConsent,
  type Verdict,
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

export { INSTRUCTIONS, TOOLS } from './tooldefs.js';

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
