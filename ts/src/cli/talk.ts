/** Talk to a service: hello, ask, intent, commit, undo, expand, and `yea do`. */
import { createInterface, type Interface } from 'node:readline/promises';
import { signer } from '../approvers.js';
import type { Client } from '../client.js';
import { type Approver, consentRound } from '../consent-round.js';
import { principalKey } from '../home.js';
import { untrustedLens } from '../lens.js';
import { jsonPrintable } from '../text.js';
import type { Proposal, Reply } from '../types.js';
import { die, type Options } from './shared.js';

/** `key=value` arguments as params; a value that parses as JSON is JSON. */
function kv(pairs: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (const p of pairs) {
    const i = p.indexOf('=');

    if (i < 0) {
      die(`expected key=value, got ${p}`);
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
const show = (r: Reply, o: Options) =>
  o.json
    ? console.log(
        jsonPrintable(JSON.stringify({ ...r, lens: undefined }, null, 2)),
      )
    : say(r);

/** A reply's progress events, on stderr and escaped like the reply itself. */
const onEvent = (e: Reply) => console.error(untrustedLens(e));

const budgetFlag = (o: Options) => (o.budget ? Number(o.budget) : undefined);

export async function cmdHello(c: Client, _args: string[], o: Options) {
  show(await c.hello(budgetFlag(o)), o);
}

export async function cmdAsk(
  c: Client,
  [capability, ...params]: string[],
  o: Options,
) {
  show(await c.ask(capability, kv(params), { budget: budgetFlag(o) }), o);
}

export async function cmdIntent(
  c: Client,
  [capability, ...params]: string[],
  o: Options,
) {
  show(
    await c.intent(capability, kv(params), {
      goal: o.goal,
      budget: budgetFlag(o),
    }),
    o,
  );
}

export async function cmdCommit(c: Client, [id, hash]: string[], o: Options) {
  show(await c.commit({ id, hash }, { onEvent }), o);
}

export async function cmdUndo(c: Client, [receipt]: string[], o: Options) {
  show(await c.undo(receipt, { onEvent }), o);
}

export async function cmdExpand(c: Client, [handle]: string[], o: Options) {
  show(await c.expand(handle, { budget: budgetFlag(o) }), o);
}

/** `yea do <url> <capability> [key=value …]`. */
export async function cmdDo(
  c: Client,
  [capability, ...params]: string[],
  o: Options,
) {
  await interactive(c, capability, kv(params), o);
}

/** `yea do`: intent → choose → commit, answering questions and consent prompts at the terminal. */
async function interactive(
  c: Client,
  capability: string,
  params: Record<string, unknown>,
  o: Options,
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

      if (!chosen) {
        return;
      }

      await commitChosen(c, rl, chosen);

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
      `✗ the service's consent request can't be signed (${out.why}); not signing`,
    );
  }
}
