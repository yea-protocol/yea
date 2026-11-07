/**
 * The consent round's far end (SPEC.md §6.6, SPEC-bridge "yea approve"): a consent code the
 * round handed out, approved where the principal key is. The code is checked like a service's
 * request, against the proposal it carries; the approver is asked, and its grant checked, the
 * same way the round does it.
 */

import { consentRecipient, decodeConsentCode } from '../consent.js';
import type { Approver, ConsentAsk } from '../consent-round.js';
import { sha256 } from '../crypto.js';
import { fmtTime } from '../lens.js';
import { printable } from '../text.js';
import { unixNow } from '../util.js';
import { checkConsentRequest, consentFrom, consentLines } from './check.js';
import { grantMismatch } from './grant.js';

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
    why: `${r.why}. The code suggests --to ${named} (fingerprint ${await keyFingerprint(named)}); check it with the agent before passing it`,
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
  /** The time, in seconds; now by default. */
  now?: number;
}

/**
 * The ask for a consent code, or why it can't be approved. The consent expires with the code and
 * its proposal: SPEC.md §4.4 commits a proposal no grant authorized only with a consent whose `exp`
 * is the proposal's, so it isn't capped, and a long one is flagged before the y/N (SPEC-bridge).
 */
async function askForCode(o: CodeApproval): Promise<ConsentAsk | Refusal> {
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

  if (!c.detail) {
    return { ok: false, why: NO_DETAIL };
  }

  const agent = await recipientOf(c.agent, o);

  if ('why' in agent) {
    return { ok: false, why: agent.why };
  }

  const why = await checkConsentRequest(c, c.detail);

  if (why) {
    return { ok: false, why: `this consent code can't be approved: ${why}` };
  }

  const request = consentFrom(c, c.detail);

  return {
    request,
    proposal: c.detail,
    agent: agent.key,
    lines: [
      ...consentLines(c, c.detail),
      `  consent issued to agent: ${agent.key} (fingerprint ${await keyFingerprint(agent.key)})`,
      `  approval expires: ${fmtTime(request.expires)}`,
      ...longConsentLines(request.expires, o.now ?? unixNow()),
    ],
    reason: '',
  };
}

/**
 * Approve one protocol consent code for `principal` (its public key): check it, pick the agent
 * (SPEC-bridge), ask the approver, and check the grant it signs. A code the approver hands on
 * again, or declines, is not approved.
 */
export async function approveCode(
  o: CodeApproval & { approver: Approver },
): Promise<{ ok: true; grant: string; agent: string; hash: string } | Refusal> {
  const ask = await askForCode(o);

  if ('ok' in ask) {
    return ask;
  }

  const a = await o.approver(ask);

  if (!('grant' in a)) {
    return { ok: false, why: 'not approved' };
  }

  const bad = await grantMismatch(a.grant, ask);

  return bad
    ? { ok: false, why: `the consent given can't be used: ${bad}` }
    : { ok: true, grant: a.grant, agent: ask.agent, hash: ask.request.hash };
}
