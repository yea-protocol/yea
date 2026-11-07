/**
 * `yea approve`: review and sign a one-time consent for one proposal or one job plan, given its
 * consent code or, on the same account, the short id of a pending one (SPEC-approval §6).
 */
import { approveConsentCode } from '../approve.js';
import { decodeConsentCode } from '../consent.js';
import { NO_DETAIL } from '../consent-round.js';
import type { KeyPair } from '../crypto.js';
import { agentKey, principalKey, saveGrant } from '../home.js';
import { printable } from '../text.js';
import { unixNow } from '../util.js';
import { approveJob } from './approve/job.js';
import { NO_TERMINAL } from './approve/terminal.js';
import { command, type Flags, type Values } from './command.js';
import { pendingCode, pendingLines } from './pending.js';
import { confirm, die } from './shared.js';

const APPROVE_FLAGS = {
  to: {
    type: 'string',
    value: 'key',
    help: "the agent key the consent is for, if not this machine's (check its fingerprint first)",
  },
} as const satisfies Flags;

export const cmdApprove = command({
  summary:
    "Review a proposal's real effects and sign a one-time consent for it. With no argument, list the pending ones.",
  usage: 'approve [<id>|<code>] [flags]',
  flags: APPROVE_FLAGS,
  example: 'yea approve k7m2x9qa4b',
  run: approve,
});

async function approve(rest: string[], o: Values<typeof APPROVE_FLAGS>) {
  const arg = rest[0];

  if (arg === undefined) {
    console.log((await pendingLines(unixNow())).join('\n'));

    return;
  }

  const code = arg.startsWith('pc1.') ? arg : codeFor(arg);
  const p = await signerFor(code);

  return isJobCode(code) ? approveJob(p, code) : approveProposal(p, code, o.to);
}

/** The principal key that may sign `code`: refused first if the code shows nothing to check. */
async function signerFor(code: string): Promise<KeyPair> {
  const consent = decodeConsentCode(code);

  // Refused before any key is loaded: there's nothing here a person could check (SPEC §6.6).
  if (!consent.detail) {
    die(`✗ ${NO_DETAIL}: refusing`);
  }

  const p =
    (await principalKey()) ??
    die('no principal key here: approve on the machine that holds it');

  if (consent.principal !== p.public) {
    die(
      printable(
        `this consent is for principal ${consent.principal}, not ${p.public}`,
      ),
    );
  }

  return p;
}

/** Approve a protocol proposal's code (SPEC-bridge, "yea approve"): a y/N, then the consent. */
async function approveProposal(p: KeyPair, code: string, to?: string) {
  const r = await approveConsentCode({
    principal: p,
    code,
    localAgent: (await agentKey())?.public ?? null,
    to,
    io: {
      print: (line) => console.log(line),
      confirm: async (question) => {
        if (!process.stdin.isTTY) {
          die(NO_TERMINAL);
        }

        return confirm(question);
      },
    },
    save: (token, hash) => saveGrant(token, 'consents', hash),
  });

  if (!r.ok) {
    die(r.why === 'not approved' ? r.why : `✗ ${r.why}: refusing`);
  }

  // Printed to paste back to an agent elsewhere: its bridge takes it through yea_consent.
  console.log(r.token);
  console.error(
    r.saved
      ? "\n✓ approved: a one-time consent for this proposal only, saved for this machine's agent. Nothing needs pasting back: ask the agent to call the tool again."
      : '\n✓ approved: a one-time consent for this proposal only. Paste the consent above back to the agent (it passes it to yea_consent), then it can commit.',
  );
}

/** The code a pending id stands for, read as any pasted code is; dies saying why if there's none. */
function codeFor(id: string): string {
  const r = pendingCode(id, unixNow());

  return 'code' in r ? r.code : die(`✗ ${r.why}`);
}

/** Whether a consent code carries a job (an MCP tool's plan) rather than a proposal. */
function isJobCode(code: string): boolean {
  try {
    const d = decodeConsentCode(code).detail as unknown as
      | { job?: unknown }
      | undefined;

    return d?.job !== undefined;
  } catch {
    return false;
  }
}
