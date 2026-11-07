/**
 * `yea approve` for a job consent code (SPEC-approval §6): re-check the plan, show it, have the
 * person type its phrase, and sign a consent to the server's key. The consent is printed, to paste
 * back into the chat as `yea_consent`, and saved in the store, for a server that reads it.
 */
import { createInterface } from 'node:readline/promises';
import {
  phraseMatches,
  planLines,
  readJobConsent,
  signJobConsent,
} from '../../ask.js';
import type { KeyPair } from '../../crypto.js';
import { defaultFileStore, type FileStore } from '../../file-store.js';
import { fmtTime } from '../../lens.js';
import { printable } from '../../text.js';
import { errno, unixNow } from '../../util.js';
import { die } from '../shared.js';
import { NO_TERMINAL } from './terminal.js';

/**
 * Approve one job plan for an MCP server (SPEC-approval §6): re-check the plan hash, show the
 * plan, have the person type its phrase, and sign a consent to the server's key. It's printed,
 * to paste back into the chat, and saved in the store, for a server that reads it.
 */
export async function approveJob(p: KeyPair, code: string) {
  const j = await orRefuse(() => readJobConsent(code, unixNow()));

  console.log(printable(`at server ${j.consent.service}, tool ${j.job.tool}:`));
  console.log(
    [
      ...planLines(j.job),
      printable(`  input: ${JSON.stringify(j.job.input)}`),
    ].join('\n'),
  );
  console.log(`  approval expires: ${fmtTime(j.consent.expires)}`);

  if (!process.stdin.isTTY) {
    die(NO_TERMINAL);
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const typed = await rl.question(
    `\nto approve, type: ${printable(j.phrase)}\n› `,
  );

  rl.close();

  if (!phraseMatches(typed, j.phrase)) {
    die('not approved');
  }

  // Signed at the time it's signed, so a consent that expired while the person typed is refused.
  const token = await orRefuse(() => signJobConsent(p, j));
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
  storeRoot: string,
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
            `It's also saved in ${storeRoot}: if the server reads that store (this machine and account), the agent can just call the tool again.`,
          ),
        ]
      : [
          printable(
            `It couldn't be saved in ${storeRoot} (${unsaved}), so ${paste}`,
          ),
        ]),
  ];
}

/** What `f` resolves to, or the command dies refusing, with `f`'s error, escaped, as the reason. */
async function orRefuse<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    return die(`✗ ${printable((e as Error).message)}: refusing`);
  }
}
