/** Talk to a service: hello, ask, intent, commit, undo, expand, and `yea do`. */
import { createInterface, type Interface } from 'node:readline/promises';
import { signer } from '../approvers.js';
import type { Client } from '../client.js';
import { type Approver, consentRound } from '../consent-round.js';
import { principalKey } from '../home.js';
import { untrustedLens } from '../lens.js';
import { jsonPrintable } from '../text.js';
import type { Proposal, Reply } from '../types.js';
import {
  command,
  type Flag,
  type Flags,
  positional,
  UsageError,
  type Values,
} from './command.js';
import { CONNECT_FLAGS, client, die } from './shared.js';

/** `key=value` arguments as params; a value that parses as JSON is JSON. */
function kv(pairs: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (const p of pairs) {
    const i = p.indexOf('=');

    if (i < 0) {
      throw new UsageError(`expected key=value, got ${p}`);
    }

    const v = p.slice(i + 1);

    try {
      out[p.slice(0, i)] = JSON.parse(v);
    } catch {
      out[p.slice(0, i)] = v;
    }
  }

  return out;
}

/** Print a service's reply (`yea do`, and every command that shows one) as `untrustedLens`. */
const say = (r: Reply) => console.log(untrustedLens(r));

/** A service's reply as `--json` (without its `lens`, invisible characters escaped), or as escaped Lens. */
const show = (r: Reply, o: { json?: boolean }) =>
  o.json
    ? console.log(
        jsonPrintable(JSON.stringify({ ...r, lens: undefined }, null, 2)),
      )
    : say(r);

/** A reply's progress events, on stderr and escaped like the reply itself. */
const onEvent = (e: Reply) => console.error(untrustedLens(e));

const budgetFlag = (o: { budget?: string }) =>
  o.budget ? Number(o.budget) : undefined;

/** The flags of a command that prints a service's reply. */
const REPLY_FLAGS = {
  ...CONNECT_FLAGS,
  json: { type: 'boolean', help: 'print the reply as JSON instead of Lens' },
} as const satisfies Flags;

const GOAL_FLAG = {
  type: 'string',
  value: 'text',
  help: 'what you are trying to do, so the service can propose better',
} as const satisfies Flag;

/**
 * Connect to the service at `args[0]`, give `talk` the client and the other arguments, and
 * hang up. A missing `<url>` or one of the arguments named in `needs` is a usage error, before
 * connecting.
 */
async function withService(
  args: string[],
  o: Values<typeof CONNECT_FLAGS>,
  needs: string[],
  talk: (c: Client, rest: string[]) => Promise<void>,
) {
  const url = positional(args, 0, 'url');
  const rest = args.slice(1);

  for (const [i, what] of needs.entries()) {
    positional(rest, i, what);
  }

  const c = await client(url, o);

  try {
    await talk(c, rest);
  } finally {
    c.close();
  }
}

export const cmdHello = command({
  summary: "Show a service's brief: who it is and what it can do.",
  usage: 'hello <url> [flags]',
  flags: REPLY_FLAGS,
  example: 'yea hello yea://127.0.0.1:7447',
  run: (args, o) =>
    withService(args, o, [], async (c) =>
      show(await c.hello(budgetFlag(o)), o),
    ),
});

export const cmdAsk = command({
  summary: 'Call a read-only capability.',
  usage: 'ask <url> <capability> [key=value …] [flags]',
  flags: REPLY_FLAGS,
  example: 'yea ask yea://127.0.0.1:7447 calendar.free day=2026-09-24',
  run: (args, o) => {
    const params = kv(args.slice(2));

    return withService(args, o, ['capability'], async (c, [capability]) =>
      show(await c.ask(capability, params, { budget: budgetFlag(o) }), o),
    );
  },
});

export const cmdIntent = command({
  summary: 'Ask a service to propose an action, without doing it.',
  usage: 'intent <url> <capability> [key=value …] [flags]',
  flags: { ...REPLY_FLAGS, goal: GOAL_FLAG },
  example: 'yea intent yea://127.0.0.1:7447 calendar.reschedule event=Ana',
  run: (args, o) => {
    const params = kv(args.slice(2));

    return withService(args, o, ['capability'], async (c, [capability]) =>
      show(
        await c.intent(capability, params, {
          goal: o.goal,
          budget: budgetFlag(o),
        }),
        o,
      ),
    );
  },
});

export const cmdCommit = command({
  summary: 'Carry out a proposal, by its id and hash.',
  usage: 'commit <url> <proposal-id> <hash> [flags]',
  flags: REPLY_FLAGS,
  example: 'yea commit yea://127.0.0.1:7447 p_HGgxOZ4L <hash>',
  run: (args, o) =>
    withService(args, o, ['proposal-id', 'hash'], async (c, [id, hash]) =>
      show(await c.commit({ id, hash }, { onEvent }), o),
    ),
});

export const cmdUndo = command({
  summary: 'Undo a committed action, by its receipt id.',
  usage: 'undo <url> <receipt-id> [flags]',
  flags: REPLY_FLAGS,
  example: 'yea undo yea://127.0.0.1:7447 <receipt-id>',
  run: (args, o) =>
    withService(args, o, ['receipt-id'], async (c, [receipt]) =>
      show(await c.undo(receipt, { onEvent }), o),
    ),
});

export const cmdExpand = command({
  summary: 'Fetch more of a reply that was cut to fit its budget.',
  usage: 'expand <url> <handle> [flags]',
  flags: REPLY_FLAGS,
  example: 'yea expand yea://127.0.0.1:7447 <handle> --budget 2000',
  run: (args, o) =>
    withService(args, o, ['handle'], async (c, [handle]) =>
      show(await c.expand(handle, { budget: budgetFlag(o) }), o),
    ),
});

export const cmdDo = command({
  summary:
    'Intent, choose, commit: do something at the terminal, answering questions and consent prompts.',
  usage: 'do <url> <capability> [key=value …] [flags]',
  flags: { ...CONNECT_FLAGS, goal: GOAL_FLAG },
  example: 'yea do yea://127.0.0.1:7447 calendar.reschedule event=Ana',
  run: (args, o) => {
    const params = kv(args.slice(2));

    return withService(args, o, ['capability'], (c, [capability]) =>
      interactive(c, capability, params, o),
    );
  },
});

/** `yea do`: intent → choose → commit, answering questions and consent prompts at the terminal. */
async function interactive(
  c: Client,
  capability: string,
  params: Record<string, unknown>,
  o: { goal?: string },
) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    for (;;) {
      const r = await c.intent(capability, params, { goal: o.goal });

      say(r);

      if (r.kind === 'CLARIFY') {
        const n = Number(await rl.question('\nchoose › ')) - 1;

        Object.assign(params, r.options[n]?.params ?? die('no such option'));

        continue;
      }

      if (r.kind !== 'PROPOSALS') {
        return;
      }

      const chosen = await chooseProposal(rl, r.proposals);

      if (chosen) {
        await commitChosen(c, rl, chosen);
      }

      return;
    }
  } finally {
    rl.close();
  }
}

/** Pick the proposal to commit: confirm a lone one, or choose by number. Null means stop. */
async function chooseProposal(
  rl: Interface,
  proposals: Proposal[],
): Promise<Proposal | null> {
  const pick =
    proposals.length === 1
      ? proposals[0]
      : (proposals.find((p) => p.id === '') ?? null);

  if (pick) {
    return /^y/i.test(await rl.question('\ncommit? [y/N] › ')) ? pick : null;
  }

  const ans = await rl.question(
    `\ncommit which? [1-${proposals.length}, blank to stop] › `,
  );

  if (!ans.trim()) {
    return null;
  }

  return proposals[Number(ans) - 1] ?? die('no such proposal');
}

/**
 * At the terminal: if the principal key the consent is for is here, show the proposal and, on
 * a yes, sign a one-time consent. Otherwise decline: the service's error is the answer.
 */
const terminalApprover =
  (rl: Interface): Approver =>
  async (ask) => {
    const p = await principalKey();

    if (!p || p.public !== ask.request.principal) {
      return { declined: true };
    }

    return signer(p, async ({ lines, reason }) => {
      // SPEC.md §6.6: effects, uses, risk and undo, from the proposal whose hash was just checked.
      console.log(['', reason, ...lines.map((l) => `  ${l}`)].join('\n'));

      return /^y/i.test(
        await rl.question(
          '\n[principal] approve this exact proposal? [y/N] › ',
        ),
      );
    })(ask);
  };

/** Commit `chosen` through the consent round, and print how it ended; a refusal exits. */
async function commitChosen(c: Client, rl: Interface, chosen: Proposal) {
  const out = await consentRound({
    client: c,
    proposal: chosen,
    approver: terminalApprover(rl),
    onEvent: say,
  });

  say(out.reply);

  if (out.kind === 'refused') {
    die(
      out.expired
        ? `✗ ${out.why}`
        : `✗ the service's consent request can't be signed (${out.why}); not signing`,
    );
  }
}
