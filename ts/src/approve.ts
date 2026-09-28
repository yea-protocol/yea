/**
 * `yea approve` for a protocol consent code (SPEC.md §6.6, SPEC-bridge "yea approve"): check
 * the code, show the proposal it carries, ask, and sign a one-time consent to the agent. The
 * terminal is passed in, so the logic can be tested; the CLI supplies stdin and stdout.
 */
import { type KeyPair, proposalHash, sha256 } from './crypto.js';
import { consentGrant, consentRecipient, decodeConsentCode } from './grants.js';
import { fmtTime, lens } from './lens.js';
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

/** A proposal's Lens without the header line. */
const proposalLens = (d: Proposal) =>
  lens({ yea: 1, id: '-', re: '-', kind: 'PROPOSALS', proposals: [d] })
    .split('\n')
    .slice(1);

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

  if (
    d.id !== consent.proposal ||
    d.hash !== consent.hash ||
    d.capability !== consent.capability ||
    (d.uses !== undefined && !isUses(d.uses)) ||
    (await proposalHash(d)) !== consent.hash
  ) {
    return { why: "this consent code's proposal doesn't match its hash" };
  }

  return {
    lines: [
      `at ${printable(consent.service)}:`,
      ...proposalLens(d).map(printable),
    ],
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
