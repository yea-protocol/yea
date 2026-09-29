/**
 * The approval core for job tools (docs/framework/SPEC-approval.md): plan hashes, the policy
 * decision, reservations against `total` limits, and undo. What a person is asked and how
 * their answer is judged is in ask.ts. Store-agnostic and dependency-free.
 * The parts live in approval/: plans, tightening, the policy decision, reservations, consent and undo.
 */

export { checkJobConsent } from './approval/job-consent.js';

export {
  assertIntegers,
  type HashedPlan,
  hashPlans,
  type JobPlan,
  planHashOf,
  planPreimage,
  planTooDeep,
} from './approval/plans.js';

export { type Decision, decide, type Policy } from './approval/policy.js';
export { type ReserveFor, reserveAll } from './approval/reservations.js';
export { readTightening, type Tightening } from './approval/tightening.js';

export {
  isReceiptId,
  newReceiptId,
  type UndoOutcome,
  undoJob,
} from './approval/undo.js';
