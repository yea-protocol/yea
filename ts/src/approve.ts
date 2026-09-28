/**
 * `yea approve` for a protocol consent code (SPEC.md §6.6, SPEC-bridge "yea approve"): check
 * the code, show the proposal it carries, ask, and sign a one-time consent to the agent. The
 * terminal is passed in, so the logic can be tested; the CLI supplies stdin and stdout.
 */
import { type KeyPair, proposalHash, sha256 } from './crypto.js';
import { consentGrant, consentRecipient, decodeConsentCode } from './grants.js';
import { fmtTime, proposalsLines } from './lens.js';
import { printable } from './text.js';
import type { ConsentRequest, Proposal } from './types.js';
import { isUses } from './uses.js';

/** The person's side: lines shown to them, and a y/N question. */
export interface ApproveIO {
  print(line: string): void;
  /** True only on an explicit yes. */
  confirm(question: string): Promise<boolean>;
}

export type ApproveOutcome =
  | { ok: true; token: string; agent: string; saved: boolean }
  | { ok: false; why: string };

/** A short fingerprint of a key, to compare by eye: the first 8 b64url characters of its sha256. */
export const keyFingerprint = async (key: string) =>
  (await sha256(key)).slice(0, 8);

/**
 * A proposal as a person is shown it before consenting (SPEC.md §6.6): its Lens without the
 * header line, so its summary, effects, uses, risk, undo and expiry. The text comes from the
 * service, so each line is escaped with `printable`, a newline inside a field included.
 */
export const proposalLens = (p: Proposal): string[] =>
  proposalsLines([p]).slice(1).map(printable);

/**
 * Why a proposal can't be bound by a consent, or null if it can (SPEC.md §5.1): its `uses`
 * must be well formed and it must hash to its `hash`. One that canonical JSON can't hash (a
 * float, say) can't be bound either.
 */
export async function checkProposal(p: Proposal): Promise<string | null> {
  if (p.uses !== undefined && !isUses(p.uses)) {
    return 'the proposal has a malformed uses';
  }

  try {
    if ((await proposalHash(p)) === p.hash) {
      return null;
    }
  } catch {
    // Unhashable: refused below like any other mismatch.
  }

  return "the proposal doesn't match its hash";
}

/**
 * Why consent request `k` can't be shown for signing against `p`, the proposal the agent got
 * from the service; null when it can (SPEC.md §6.6). Its proposal, hash and capability must
 * be `p`'s, and `p` must pass `checkProposal`. `service` is where `p` came from, when the
 * caller knows it apart from `k` (a consent code carries only its own claim).
 */
export async function checkConsentRequest(
  k: ConsentRequest,
  p: Proposal,
  service?: string,
): Promise<string | null> {
  const checks: [boolean, string][] = [
    [k.proposal !== p.id, 'the consent request names another proposal'],
    [k.hash !== p.hash, "the consent request's hash isn't the proposal's"],
    [
      k.capability !== p.capability,
      'the consent request names another capability',
    ],
    [
      service !== undefined && k.service !== service,
      'the consent request names another service',
    ],
  ];
  const mismatch = checks.find(([bad]) => bad);

  return mismatch ? mismatch[1] : checkProposal(p);
}

/** What a code asks for, as lines to show; or why it can't be shown (its detail doesn't hash). */
export async function consentLines(
  consent: ConsentRequest & { detail?: Proposal },
): Promise<{ lines: string[] } | { why: string }> {
  const d = consent.detail;

  if (!d) {
    return {
      lines: [
        "⚠ no proposal details in this code; only the service's summary:",
        printable(consent.summary),
        printable(
          `  service: ${consent.service} · ${consent.capability} · proposal ${consent.proposal}`,
        ),
      ],
    };
  }

  const why = await checkConsentRequest(consent, d);

  if (why) {
    return { why: `this consent code can't be approved: ${why}` };
  }

  return {
    lines: [`at ${printable(consent.service)}:`, ...proposalLens(d)],
  };
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

/**
 * Approve one protocol consent code: check it's for `principal`, pick the agent (SPEC-bridge),
 * show the proposal, ask, and sign. `save` keeps the consent only when this machine's agent key
 * is the one it's issued to; the caller prints the token to paste back either way.
 */
export async function approveConsentCode(o: {
  principal: KeyPair;
  code: string;
  localAgent: string | null;
  to?: string;
  io: ApproveIO;
  save(token: string, hash: string): void;
}): Promise<ApproveOutcome> {
  let consent: ReturnType<typeof decodeConsentCode>;

  try {
    consent = decodeConsentCode(o.code);
  } catch (e) {
    return { ok: false, why: (e as Error).message };
  }

  if (consent.principal !== o.principal.public) {
    return {
      ok: false,
      why: `this consent is for principal ${printable(consent.principal)}, not ${o.principal.public}`,
    };
  }

  const agent = await recipientOf(consent.agent, o);

  if ('why' in agent) {
    return { ok: false, why: agent.why };
  }

  const shown = await consentLines(consent);

  if ('why' in shown) {
    return { ok: false, why: shown.why };
  }

  return signIfApproved(o, { consent, agent: agent.key, shown: shown.lines });
}

/** Show the proposal and the agent, ask, then sign and save. */
async function signIfApproved(
  o: Parameters<typeof approveConsentCode>[0],
  c: { consent: ConsentRequest; agent: string; shown: string[] },
): Promise<ApproveOutcome> {
  for (const line of [
    ...c.shown,
    `  consent issued to agent: ${c.agent} (fingerprint ${await keyFingerprint(c.agent)})`,
    `  approval expires: ${fmtTime(c.consent.expires)}`,
  ]) {
    o.io.print(line);
  }

  if (!(await o.io.confirm('\napprove this exact action? [y/N] › '))) {
    return { ok: false, why: 'not approved' };
  }

  const token = await consentGrant({
    principal: o.principal,
    agent: c.agent,
    consent: c.consent,
  });
  const saved = o.localAgent === c.agent;

  if (saved) {
    o.save(token, c.consent.hash);
  }

  return { ok: true, token, agent: c.agent, saved };
}
