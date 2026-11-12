/**
 * The consent round's far end (SPEC.md §6.6, SPEC-bridge "yea approve"): a consent code the
 * round handed out, approved where the principal key is. The code is checked like a service's
 * request, against the proposal it carries; the approver is asked, and its grant checked, the
 * same way the round does it.
 */

import {
  codeExpired,
  consentRecipient,
  decodeConsentCode,
} from '../consent.js';
import type { Approver } from '../consent-round.js';
import { sha256 } from '../crypto.js';
import { fmtTime } from '../lens.js';
import { printable } from '../text.js';
import type { ConsentRequest, Proposal } from '../types.js';
import { unixNow } from '../util.js';
import { type AskWords, askConsent } from './ask.js';
import { consentLines } from './check.js';

/** A short fingerprint of a key, to compare by eye: the first 8 b64url characters of its sha256. */
export const keyFingerprint = async (key: string) =>
  (await sha256(key)).slice(0, 8);

/** Why a consent code without its proposal is refused (SPEC.md §6.6), and what to do instead. */
export const NO_DETAIL =
  "this consent code carries no proposal, so only the service-written summary could be shown, not its effects, uses, risk and undo (SPEC.md §6.6); have the agent's tool (yea mcp, yea test-drive) make a new code, which includes the proposal";

interface Refusal {
  ok: false;
  why: string;
}

/** Who the consent is for, or why none can be chosen (with the code's suggestion, fingerprinted). */
async function recipientOf(
  named: unknown,
  o: { localAgent: string | null; to?: string },
): Promise<{ key: string } | { why: string }> {
  const r = consentRecipient({ code: named, local: o.localAgent, to: o.to });

  if ('key' in r || typeof named !== 'string' || o.to !== undefined) {
    return r;
  }

  return {
    why: `${r.why}. The code suggests --to ${printable(named)} (fingerprint ${await keyFingerprint(named)}); check it with the agent before passing it`,
  };
}

/** A consent valid for longer than this, in seconds, gets a warning before the y/N: an hour. */
const LONG_CONSENT = 3600;

/** Whole days, hours and minutes, in seconds, largest first. */
const UNITS = [
  ['d', 86400],
  ['h', 3600],
  ['m', 60],
] as const;

/** A span of `s` seconds for a person to read: its two largest units that aren't 0, as `23h 59m`. */
function roughly(s: number): string {
  const parts: string[] = [];
  let rest = s;

  for (const [unit, size] of UNITS) {
    if (rest >= size) {
      parts.push(`${Math.floor(rest / size)}${unit}`);
      rest %= size;
    }
  }

  return parts.slice(0, 2).join(' ');
}

/**
 * The warning before the y/N when the consent stays valid for over `LONG_CONSENT`: it expires with
 * its proposal, so a service that keeps a proposal open for long keeps the consent valid as long.
 */
function longConsentLines(expires: number, now: number): string[] {
  const left = expires - now;

  return left > LONG_CONSENT
    ? [
        '',
        `⚠ this approval stays valid until ${printable(fmtTime(expires))}, ${roughly(left)} from now`,
      ]
    : [];
}

/** What approving a code needs: the code, whose it must be, and where it's being approved. */
interface CodeApproval {
  code: string;
  /** The principal's public key: the code must name it. */
  principal: string;
  localAgent: string | null;
  to?: string;
  /** The clock, in seconds; the system's by default. */
  now?: () => number;
}

/** A code that passed its own checks, and the proposal it carries. */
interface CheckedCode {
  code: ReturnType<typeof decodeConsentCode>;
  proposal: Proposal;
}

/** How `yea approve` says why it refused a code (#370); the live round has its own words. */
const CODE_WORDS: AskWords = {
  expired: codeExpired,
  mismatch: (why) => `this consent code can't be approved: ${why}`,
  unusable: (why) => `the consent given can't be used: ${why}`,
};

/**
 * The code checked on its own, before anyone is asked anything: it must be for `principal`, and
 * carry its proposal. The ask step then checks it against that proposal, as a service's request
 * is checked (SPEC.md §6.6), and its consent's expiry. The consent expires with the code and its
 * proposal: §4.4 commits a proposal no grant authorized only with a consent whose `exp` is the
 * proposal's, so it isn't capped.
 */
function checkCode(o: CodeApproval): CheckedCode | Refusal {
  let c: ReturnType<typeof decodeConsentCode>;

  try {
    c = decodeConsentCode(o.code);
  } catch (e) {
    return { ok: false, why: (e as Error).message };
  }

  if (c.principal !== o.principal) {
    return {
      ok: false,
      why: `this consent is for principal ${printable(c.principal)}, not ${o.principal}`,
    };
  }

  return c.detail
    ? { code: c, proposal: c.detail }
    : { ok: false, why: NO_DETAIL };
}

/**
 * The rest of the ask for a code's consent, `request`, at `now`, or why it can't be approved: the
 * agent it's for (SPEC-bridge), and what the person is shown. A consent valid for long is flagged
 * before the y/N.
 */
async function codeAsk(
  { code, proposal }: CheckedCode,
  request: ConsentRequest,
  now: number,
  o: CodeApproval,
) {
  const agent = await recipientOf(code.agent, o);

  if ('why' in agent) {
    return agent;
  }

  return {
    agent: agent.key,
    lines: [
      ...consentLines(code, proposal),
      `  consent issued to agent: ${agent.key} (fingerprint ${await keyFingerprint(agent.key)})`,
      `  approval expires: ${fmtTime(request.expires)}`,
      ...longConsentLines(request.expires, now),
    ],
    reason: '',
  };
}

/**
 * Approve one protocol consent code for `principal` (its public key): check it, pick the agent
 * (SPEC-bridge), ask the approver, and check the grant it signs, through the round's ask step. A
 * code the approver hands on again, or declines, is not approved, nor is one whose consent
 * expires while the person reads.
 */
export async function approveCode(
  o: CodeApproval & { approver: Approver },
): Promise<{ ok: true; grant: string; agent: string; hash: string } | Refusal> {
  const checked = checkCode(o);

  if ('ok' in checked) {
    return checked;
  }

  const asked = await askConsent({
    request: checked.code,
    proposal: checked.proposal,
    build: (request, now) => codeAsk(checked, request, now, o),
    approver: o.approver,
    clock: o.now ?? unixNow,
    words: CODE_WORDS,
  });

  if (asked.kind === 'grant') {
    const { grant, ask } = asked;

    return { ok: true, grant, agent: ask.agent, hash: ask.request.hash };
  }

  return {
    ok: false,
    why: asked.kind === 'refused' ? asked.why : 'not approved',
  };
}
