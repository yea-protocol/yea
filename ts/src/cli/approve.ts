/** `yea approve`: review and sign a one-time consent for one proposal or one job plan. */
import { createInterface } from 'node:readline/promises';
import { approveConsentCode } from '../approve.js';
import {
  type JobConsent,
  phraseMatches,
  planLines,
  readJobConsent,
  signJobConsent,
} from '../ask.js';
import { decodeConsentCode } from '../consent.js';
import { NO_DETAIL } from '../consent-round.js';
import type { KeyPair } from '../crypto.js';
import { defaultFileStore } from '../file-store.js';
import { agentKey, principalKey, saveGrant } from '../home.js';
import { fmtTime } from '../lens.js';
import { printable } from '../text.js';
import { unixNow } from '../util.js';
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

/**
 * Approve one job plan for an MCP server (SPEC-approval §6): re-check the plan hash, show the
 * plan, have the person type its phrase, and store a consent signed to the server's key.
 */
async function approveJob(p: KeyPair, code: string) {
  const now = unixNow();
  let j: JobConsent;

  try {
    j = await readJobConsent(code, now);
  } catch (e) {
    die(`✗ ${printable((e as Error).message)}: refusing`);
  }

  console.log(printable(`at server ${j.consent.service}, tool ${j.job.tool}:`));
  console.log(
    [
      ...planLines(j.job),
      printable(`  input: ${JSON.stringify(j.job.input)}`),
    ].join('\n'),
  );
  console.log(`  approval expires: ${fmtTime(j.consent.expires)}`);

  if (!process.stdin.isTTY) {
    die('✗ approval needs an interactive terminal: a human has to confirm');
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const typed = await rl.question(
    `\nto approve, type: ${printable(j.phrase)}\n› `,
  );

  rl.close();

  if (!phraseMatches(typed, j.phrase)) {
    die('not approved');
  }

  await defaultFileStore().putConsent(j.planHash, await signJobConsent(p, j));
  console.log(
    '✓ approved: a one-time consent for this plan only. Ask the agent to call the tool again.',
  );
}
