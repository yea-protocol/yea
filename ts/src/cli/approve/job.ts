/**
 * `yea approve` for a job consent code (SPEC-approval §6): re-check the plan, show it, have the
 * person type its phrase, and sign a consent to the server's key. The consent is printed, and
 * saved in the store only if it's the one the consent binds, which the server reads; otherwise
 * the person pastes it back into the chat, for the call to carry as `yea_consent`.
 */
import { createInterface } from 'node:readline/promises';
import {
  type JobConsent,
  phraseMatches,
  planLines,
  readJobConsent,
  signJobConsent,
} from '../../ask.js';
import type { KeyPair } from '../../crypto.js';
import {
  defaultFileStore,
  type FileStore,
  readStoreId,
} from '../../file-store.js';
import { fmtTime } from '../../lens.js';
import { printable } from '../../text.js';
import { errno, unixNow } from '../../util.js';
import { die } from '../shared.js';
import { NO_TERMINAL } from './terminal.js';

/**
 * Approve one job plan for an MCP server (SPEC-approval §6): re-check the plan hash, show the
 * plan, have the person type its phrase, and sign a consent to the server's key. It's printed,
 * and saved where the server reads it, or else pasted back into the chat.
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
  const saved = await saveConsent(store, j, token);

  // Printed to paste back when it isn't saved where the server reads: the tool takes it as
  // yea_consent.
  console.log(token);
  console.error(`\n${jobApprovedLines(store.root, saved).join('\n')}`);
}

/** Where a signed consent went: saved where the server that asked reads it, or why not. */
export type Saved =
  | { saved: true }
  | { saved: false; elsewhere: true }
  | { saved: false; failed: string };

/**
 * Save a consent in `store` only if it's the store the consent binds (its id is the code's
 * `store`), which is the one the server that asked reads; in any other it could never run. A
 * failed save doesn't fail the approval: the consent is signed, and the call can carry it.
 */
export async function saveConsent(
  store: FileStore,
  j: Pick<JobConsent, 'planHash' | 'store'>,
  token: string,
): Promise<Saved> {
  try {
    if (readStoreId(store.root) !== j.store) {
      return { saved: false, elsewhere: true };
    }

    await store.putConsent(j.planHash, token);

    return { saved: true };
  } catch (e) {
    return { saved: false, failed: errno(e) ?? (e as Error).message };
  }
}

const PASTE =
  'paste the consent above back into the chat: the agent passes it to the tool as yea_consent.';

/**
 * What the person is told once a job consent is signed (SPEC-approval §6): nothing to paste when
 * it's saved where the server reads it; else why not, and to paste it back.
 */
export function jobApprovedLines(storeRoot: string, s: Saved): string[] {
  if (s.saved) {
    return [
      printable(
        `✓ approved: a one-time consent for this plan only, saved in ${storeRoot}, where the server that asked reads it.`,
      ),
      'Nothing needs pasting back: ask the agent to call the tool again.',
    ];
  }

  const why =
    'failed' in s
      ? `It couldn't be saved in ${storeRoot} (${s.failed})`
      : `The server that asked doesn't keep its approvals in ${storeRoot}`;

  return [
    '✓ approved: a one-time consent for this plan only.',
    printable(`${why}, so ${PASTE}`),
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
