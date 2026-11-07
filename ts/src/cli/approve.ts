/** `yea approve`: review and sign a one-time consent for one proposal or one job plan. */
import { createInterface } from 'node:readline/promises';
import { approveConsentCode } from '../approve.js';
import {
  type JobConsent,
  phraseMatches,
  readJobConsent,
  signJobConsent,
} from '../ask.js';
import { decodeConsentCode } from '../consent.js';
import { NO_DETAIL } from '../consent-round.js';
import type { KeyPair } from '../crypto.js';
import { defaultFileStore, type FileStore } from '../file-store.js';
import { agentKey, principalKey, saveGrant } from '../home.js';
import { effectLine, fmtDuration, fmtTime } from '../lens.js';
import { printable } from '../text.js';
import { fmtUses, isUses } from '../uses.js';
import { errno, unixNow } from '../util.js';
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
 * plan, have the person type its phrase, and sign a consent to the server's key. It's printed,
 * to paste back into the chat, and saved in the store, for a server that reads it.
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
  console.log(jobLines(j.job).map(printable).join('\n'));
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

  const token = await signJobConsent(p, j);
  const store = defaultFileStore();
  const unsaved = await saveConsent(store, j.planHash, token);

  // Printed to paste back: the job tool takes it as yea_consent.
  console.log(token);
  console.error(`\n${jobApprovedLines(store.root, unsaved).join('\n')}`);
}

/**
 * Save a consent where a server on this account reads it; null, or why it couldn't be. A failed
 * save doesn't fail the approval: the consent is signed, and the call can carry it.
 */
export async function saveConsent(
  store: FileStore,
  planHash: string,
  token: string,
): Promise<string | null> {
  try {
    await store.putConsent(planHash, token);

    return null;
  } catch (e) {
    return errno(e) ?? String(e);
  }
}

/**
 * What the person is told once a job consent is signed (SPEC-approval §6): paste it back, which
 * works wherever the server is; and where it was saved, or why it couldn't be.
 */
export function jobApprovedLines(
  store: string,
  unsaved: string | null,
): string[] {
  const paste =
    'paste the consent above back into the chat: the agent passes it to the tool as yea_consent.';

  return [
    '✓ approved: a one-time consent for this plan only.',
    ...(unsaved === null
      ? [
          `To use it, ${paste}`,
          printable(
            `It's also saved in ${store}: if the server reads that store (this machine and account), the agent can just call the tool again.`,
          ),
        ]
      : [
          printable(
            `It couldn't be saved in ${store} (${unsaved}), so ${paste}`,
          ),
        ]),
  ];
}

/** The plan as the person reads it: summary, effects, then what it uses, risk and undo. */
function jobLines(job: JobConsent['job']): string[] {
  const uses =
    isUses(job.uses) && Object.keys(job.uses).length
      ? `uses: ${fmtUses(job.uses)} · `
      : '';
  const undo =
    typeof job.undoWindow === 'number' ? fmtDuration(job.undoWindow) : 'never';

  return [
    job.summary,
    ...job.effects.map((e) => `  ${effectLine(e)}`),
    `  ${uses}risk: ${String(job.risk)} · undo: ${undo}`,
    `  input: ${JSON.stringify(job.input)}`,
  ];
}
