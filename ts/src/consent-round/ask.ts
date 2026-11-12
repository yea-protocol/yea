/**
 * The ask step both ends of the consent round share (SPEC.md §6.6): the live round, for a
 * service's consent request, and `yea approve`, for a consent code. It owns the order: check the
 * request against its proposal, refuse it if its consent has expired, build the ask, ask, refuse
 * an answer that comes back once the consent has expired, and check the grant. Both expiry
 * checks and the grant's are read by the one clock it's given. The approver is handed a copy of
 * the ask in plain data: the answer is checked against the ask as built, whatever the approver
 * does to its copy, and a proposal kept behind a proxy (a page's reactive store) can be asked
 * about.
 */
import type { Approver, ConsentAsk } from '../consent-round.js';
import type { ConsentRequest, Proposal } from '../types.js';
import { plainCopy } from '../util.js';
import { checkConsentRequest, consentFrom } from './check.js';
import { grantMismatch } from './grant.js';

/** A consent refused as expired: when it expired, and the clock's reading then, in seconds. */
export interface Expiry {
  expires: number;
  now: number;
}

/** How an entry point says why the step refused, in its own words. */
export interface AskWords {
  /**
   * Why a consent valid until `expires`, to a proposal valid until `proposalExpires`, is refused
   * at `now`; null while it's valid.
   */
  expired: (
    expires: number,
    now: number,
    proposalExpires: number,
  ) => string | null;
  /** Why a request that doesn't name its proposal (`checkConsentRequest`'s reason) is refused. */
  mismatch: (why: string) => string;
  /** Why a grant the approver gave (`grantMismatch`'s reason) can't be used. */
  unusable: (why: string) => string;
}

/** The rest of an ask, besides the consent to sign and its proposal. */
type AskParts = Pick<ConsentAsk, 'agent' | 'lines' | 'reason'>;

/** What the ask step is given: the request to ask about, how to build the ask, and who answers. */
export interface AskStep {
  /** The consent request, as the service sent it or the code carries it. */
  request: ConsentRequest;
  /** The proposal it must name: as the agent was shown it, or as the code carries it. */
  proposal: Proposal;
  /** Where the proposal came from, when that's known apart from the request. */
  service?: string;
  /**
   * The rest of the ask for the consent to sign, `request`, at the clock's reading `now`; or why
   * there's none. It's called only once the request checks out and its consent hasn't expired.
   */
  build: (
    request: ConsentRequest,
    now: number,
  ) => Promise<AskParts | { why: string }>;
  approver: Approver;
  /** The clock, in seconds: read before asking, and again once the answer comes back. */
  clock: () => number;
  words: AskWords;
}

/** A refusal, and the expiry behind it when time ran out and nothing else was wrong. */
interface Refused {
  kind: 'refused';
  why: string;
  expired?: Expiry;
}

/** How the step ended: a grant checked against its ask, a decline, a code, or a refusal. */
export type Asked =
  | { kind: 'grant'; grant: string; ask: ConsentAsk }
  | { kind: 'declined' }
  | { kind: 'pending'; code: string }
  | Refused;

/** The refusal of the consent `a` asks for if it has expired at `now`, or null while it's valid. */
function expiry(
  a: Pick<ConsentAsk, 'request' | 'proposal'>,
  now: number,
  words: AskWords,
): Refused | null {
  const { expires } = a.request;
  const why = words.expired(expires, now, a.proposal.expires);

  return why ? { kind: 'refused', why, expired: { expires, now } } : null;
}

/**
 * The ask, once the request names its proposal and the consent it builds hasn't expired; or why
 * not. A request that names something else is refused for that first.
 */
async function askFor(s: AskStep): Promise<ConsentAsk | Refused> {
  const mismatch = await checkConsentRequest(s.request, s.proposal, s.service);

  if (mismatch) {
    return { kind: 'refused', why: s.words.mismatch(mismatch) };
  }

  const request = consentFrom(s.request, s.proposal);
  const now = s.clock();
  const expired = expiry({ request, proposal: s.proposal }, now, s.words);

  if (expired) {
    return expired;
  }

  const parts = await s.build(request, now);

  return 'why' in parts
    ? { kind: 'refused', why: parts.why }
    : { ...parts, request, proposal: s.proposal };
}

/**
 * The approver's grant, if it can be used: the person may have read for a while, so a consent
 * that expired meanwhile is refused as that, before the grant check, by the same clock, would
 * call it an expired grant.
 */
async function checkAnswer(
  grant: string,
  ask: ConsentAsk,
  s: AskStep,
): Promise<Asked> {
  const now = s.clock();
  const expired = expiry(ask, now, s.words);

  if (expired) {
    return expired;
  }

  const bad = await grantMismatch(grant, ask, now);

  return bad
    ? { kind: 'refused', why: s.words.unusable(bad) }
    : { kind: 'grant', grant, ask };
}

/** Ask the approver for a consent to `s.request`, in the step's order (see the file header). */
export async function askConsent(s: AskStep): Promise<Asked> {
  const ask = await askFor(s);

  if ('kind' in ask) {
    return ask;
  }

  const a = await s.approver(plainCopy(ask));

  if ('pending' in a) {
    return { kind: 'pending', code: a.pending };
  }

  if (!('grant' in a)) {
    return { kind: 'declined' };
  }

  return checkAnswer(a.grant, ask, s);
}
