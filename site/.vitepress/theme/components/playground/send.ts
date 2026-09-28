/**
 * Sending the request form: the one client call its verb stands for, with its params,
 * budget and target.
 */
import type { Client } from '@yea-protocol/sdk';
import type { RequestForm } from './model';
import type { Seen } from './seen';

export interface SendInput {
  client: Client;
  form: RequestForm;
  seen: Seen;
  /** The form's params as an object, or null when they don't parse (nothing is sent). */
  params: () => Record<string, unknown> | null;
  /** One-off grants for a COMMIT, such as a consent grant. */
  extraGrants?: string[];
}

/** HELLO, ASK or INTENT, from the form's fields. */
async function sendCapability(
  { client, form, params }: SendInput,
  budget: number | undefined,
) {
  if (form.verb === 'HELLO') {
    await client.hello(budget);

    return;
  }

  const p = params();

  if (!p) {
    return;
  }

  if (form.verb === 'ASK') {
    await client.ask(form.capability, p, { budget });
  } else {
    await client.intent(form.capability, p, {
      budget,
      auto: form.auto,
      goal: form.goal || undefined,
    });
  }
}

/** COMMIT, UNDO or EXPAND whatever the form's target names. */
async function sendToTarget(
  { client, form, seen, extraGrants }: SendInput,
  budget: number | undefined,
) {
  if (form.verb === 'COMMIT') {
    const p = seen.proposals.find((x) => x.id === form.target);

    if (p) {
      await client.commit(
        { id: p.id, hash: p.hash },
        { budget, grants: extraGrants },
      );
    }
  } else if (form.verb === 'UNDO') {
    if (form.target) {
      await client.undo(form.target);
    }
  } else if (form.verb === 'EXPAND' && form.target) {
    await client.expand(form.target, { budget });
  }
}

/** Send the form's request, as its verb says. */
export async function sendForm(input: SendInput): Promise<void> {
  const { form } = input;
  const budget = form.useBudget ? form.budget : undefined;

  if (form.verb === 'HELLO' || form.verb === 'ASK' || form.verb === 'INTENT') {
    await sendCapability(input, budget);
  } else {
    await sendToTarget(input, budget);
  }
}
