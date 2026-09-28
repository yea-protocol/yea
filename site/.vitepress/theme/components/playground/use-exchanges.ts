/**
 * The log of exchanges: every request the agent sent and what came back, the one on show,
 * what the agent has seen so far, and the recording transport that fills them.
 */
import type { Service, Transport } from '@yea-protocol/sdk';
import { computed, reactive, ref, type ShallowRef } from 'vue';
import { type Captured, captureTransport } from './capture';
import type { Exchange, ServiceKey } from './model';
import { emptySeen, remember } from './seen';

export function useExchanges(
  services: ShallowRef<Record<ServiceKey, Service> | null>,
) {
  const log = ref<Exchange[]>([]);
  const selected = ref<number | null>(null);
  const seen = reactive(emptySeen());
  let count = 0;
  // Set while an INTENT with `auto` is in flight, so its exchanges are marked as auto.
  let auto = false;

  /** The picked exchange, else the latest. */
  const current = computed(
    () =>
      log.value.find((x) => x.n === selected.value) ??
      log.value[log.value.length - 1] ??
      null,
  );

  function record(service: ServiceKey, c: Captured) {
    const isAuto = auto && c.request.verb !== 'HELLO';

    log.value = [...log.value, { n: ++count, service, ...c, auto: isAuto }];
    remember(seen, service, c.reply);
  }

  function transportFor(service: ServiceKey): Transport {
    const svc = services.value?.[service];

    if (!svc) {
      throw new Error(`${service} is not running`);
    }

    return captureTransport(svc, (c) => record(service, c));
  }

  const markAuto = (on: boolean) => {
    auto = on;
  };

  return { log, selected, current, seen, transportFor, markAuto };
}
