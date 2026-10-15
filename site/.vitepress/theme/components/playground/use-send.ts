/**
 * Sending: one request at a time through the current service's client, with the exchange
 * shown as it lands and marked as auto when it is an INTENT with `auto` on.
 */
import type { Client } from '@yea-protocol/sdk';
import { type Ref, ref, type ShallowRef } from 'vue';
import type { RequestForm, ServiceKey } from './model';
import type { Seen } from './seen';
import { type SendInput, sendForm } from './send';

interface SendDeps {
  clients: ShallowRef<Record<ServiceKey, Client> | null>;
  form: RequestForm;
  seen: Seen;
  parsedParams: () => Record<string, unknown> | null;
  selected: Ref<number | null>;
  markAuto: (on: boolean) => void;
  commit: SendInput['commit'];
}

export function useSend(deps: SendDeps) {
  const { clients, form, seen, parsedParams, selected, markAuto, commit } =
    deps;
  const busy = ref(false);

  /** Send what the form says. */
  async function send(): Promise<void> {
    const client = clients.value?.[form.service];

    if (!client || busy.value) {
      return;
    }

    busy.value = true;
    selected.value = null;
    markAuto(form.verb === 'INTENT' && form.auto);

    try {
      await sendForm({ client, form, seen, params: parsedParams, commit });
    } finally {
      busy.value = false;
      markAuto(false);
    }
  }

  return { busy, send };
}
