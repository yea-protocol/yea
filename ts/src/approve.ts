/**
 * `yea approve` for a protocol consent code (SPEC.md §6.6, SPEC-bridge "yea approve"): the
 * consent round's `approveCode` checks the code and shows the proposal it carries; a signer
 * asks at the terminal and signs a one-time consent to the agent. The terminal is passed in, so
 * the logic can be tested; the CLI supplies stdin and stdout.
 */

import { signer } from './approvers.js';
import { approveCode } from './consent-round.js';
import type { KeyPair } from './crypto.js';

/** The person's side: lines shown to them, and a y/N question. */
export interface ApproveIO {
  print(line: string): void;
  /** True only on an explicit yes. */
  confirm(question: string): Promise<boolean>;
}

export type ApproveOutcome =
  | { ok: true; token: string; agent: string; saved: boolean }
  | { ok: false; why: string };

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
  const r = await approveCode({
    code: o.code,
    principal: o.principal.public,
    localAgent: o.localAgent,
    to: o.to,
    approver: signer(o.principal, async (ask) => {
      for (const line of ask.lines) {
        o.io.print(line);
      }

      return o.io.confirm('\napprove this exact action? [y/N] › ');
    }),
  });

  if (!r.ok) {
    return r;
  }

  const saved = o.localAgent === r.agent;

  if (saved) {
    o.save(r.grant, r.hash);
  }

  return { ok: true, token: r.grant, agent: r.agent, saved };
}
