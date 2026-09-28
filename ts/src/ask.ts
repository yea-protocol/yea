/**
 * Asking a person to approve a job (docs/framework/SPEC-approval.md §3–§6): the confirmation
 * phrase, the form, the state that goes round the client, how the answer is judged, and the
 * consent code for `yea approve` when the client can't ask. The parts live in ask/; this file
 * re-exports them.
 */

export {
  CONSENT_TTL,
  type JobConsent,
  jobConsentCode,
  readJobConsent,
  signJobConsent,
} from './ask/consent-code.js';

export { type ApprovalForm, buildForm } from './ask/form.js';

export {
  type ApprovalAnswer,
  type JudgeContext,
  judgeAnswer,
  type Verdict,
} from './ask/judge.js';

export {
  checkedPhrase,
  DEFAULT_PHRASE,
  type PhraseFor,
  phraseMatches,
} from './ask/phrase.js';

export {
  type ApprovalState,
  checkState,
  inputHashOf,
  MAX_ROUNDS,
  newState,
  STATE_TTL,
} from './ask/state.js';
