/** `yea approve`: review and sign a one-time consent for one proposal or one job plan. */
import { approveConsentCode } from '../approve.js';
import { decodeConsentCode } from '../consent.js';
import { NO_DETAIL } from '../consent-round.js';
import { agentKey, principalKey, saveGrant } from '../home.js';
import { printable } from '../text.js';
import { approveJob } from './approve/job.js';
import { command, type Flags, positional, type Values } from './command.js';
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
    "Review a proposal's real effects and sign a one-time consent for it, to paste back to the agent.",
  usage: 'approve <code> [flags]',
  flags: APPROVE_FLAGS,
  example: 'yea approve pc1.…',
  run: approve,
});

async function approve(rest: string[], o: Values<typeof APPROVE_FLAGS>) {
  const code = positional(rest, 0, 'code');
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

  if (isJobCode(code)) {
    return approveJob(p, code);
  }

  const r = await approveConsentCode({
    principal: p,
    code,
    localAgent: (await agentKey())?.public ?? null,
    to: o.to,
    io: {
      print: (line) => console.log(line),
      confirm: async (question) => {
        if (!process.stdin.isTTY) {
          die(
            '✗ approval needs an interactive terminal: a human has to confirm',
          );
        }

        return confirm(question);
      },
    },
    save: (token, hash) => saveGrant(token, 'consents', hash),
  });

  if (!r.ok) {
    die(r.why === 'not approved' ? r.why : `✗ ${r.why}: refusing`);
  }

  // Printed to paste back to the agent: its bridge takes it through yea_consent.
  console.log(r.token);
  console.error(
    `\n✓ approved: a one-time consent for this proposal only${r.saved ? ", saved for this machine's agent" : ''}. Paste the consent above back to the agent (it passes it to yea_consent), then it can commit.`,
  );
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
