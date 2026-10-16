/**
 * The person's side of the test drive: when a tool result carries the bridge's consent codes, the
 * test drive's own loop (never the agent's tools) shows each proposal and asks. On a yes it
 * approves the code as `yea approve` does, with the SDK's code path and a signer, using the
 * throwaway principal held in memory, and saves the consent to the agent's home for the bridge.
 */
import { createInterface } from 'node:readline/promises';
import {
  approveConsentCode,
  type ConsentStore,
  type KeyPair,
  printable,
} from '@yea-protocol/sdk';
import type { Code } from './host.js';
import { indent, paint } from './style.js';

/** The person's yes or no to a question. True only on an explicit yes. */
export type Confirm = (question: string) => Promise<boolean>;

/** What the person approves with: their key, the agent's, and where the agent keeps consents. */
export interface Person {
  principal: KeyPair;
  agent: string;
  consents: ConsentStore;
  confirm: Confirm;
}

/**
 * Ask at the terminal. Without a TTY nothing is approved: the question is printed, and the
 * answer is no.
 */
export const terminalConfirm: Confirm = async (question) => {
  if (!process.stdin.isTTY) {
    console.log(paint(`${question.trim()} (no terminal: not approved)`, 'dim'));

    return false;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    return /^y/i.test(await rl.question(paint(question, 'yel')));
  } finally {
    rl.close();
  }
};

/** Approve one code: show its proposal, ask, and on a yes sign and save the consent. */
async function approveOne(person: Person, c: Code): Promise<boolean> {
  console.log(`\n${paint('👤 you', 'yel')} are asked to approve:`);

  const r = await approveConsentCode({
    principal: person.principal,
    code: c.code,
    localAgent: person.agent,
    io: {
      print: (line) => console.log(indent(line)),
      confirm: person.confirm,
    },
    save: (token, hash) => person.consents.put(hash, token),
  });

  if (!r.ok && r.why !== 'not approved') {
    console.log(paint(`   ✗ ${printable(r.why)}: refusing`, 'red'));
  }

  return r.ok && r.saved;
}

/**
 * Offer each code's proposal to the person in turn, until they approve one. Returns the line
 * the model is told after the tool result: what was approved and what to do next.
 */
export async function review(person: Person, codes: Code[]): Promise<string> {
  for (const c of codes) {
    if (await approveOne(person, c)) {
      return `→ the user approved [${printable(c.proposal)}] in their terminal, and its consent is saved. Call this tool again with the same arguments to commit it.`;
    }
  }

  return "→ the user did not approve this, so nothing was committed. Tell them, and don't work around their limit.";
}
