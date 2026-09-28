/**
 * The agent's request form: its fields, the capabilities and targets it offers, and the rules
 * that keep them consistent as you switch service or verb.
 */
import type { CapabilityInfo, Service } from '@yea-protocol/sdk';
import { computed, reactive, ref, type ShallowRef, watch } from 'vue';
import { errorText, type RequestForm, type ServiceKey } from './model';
import type { Examples } from './presets';
import { type Seen, targetsOf } from './seen';

interface FormDeps {
  services: ShallowRef<Record<ServiceKey, Service> | null>;
  seen: Seen;
  examples: Examples;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export function useRequestForm({ services, seen, examples }: FormDeps) {
  const form = reactive<RequestForm>({
    service: 'calendar',
    verb: 'INTENT',
    capability: 'calendar.reschedule',
    params: JSON.stringify(examples['calendar.reschedule'], null, 2),
    goal: '',
    auto: true,
    useBudget: false,
    budget: 600,
    target: '',
  });
  const paramsError = ref('');

  /** ASK lists the service's asks; every other verb lists its intents. */
  const caps = computed((): CapabilityInfo[] => {
    const svc = services.value?.[form.service];

    if (!svc) {
      return [];
    }

    const kind = form.verb === 'ASK' ? 'ask' : 'intent';

    return svc.capabilities.filter((c) => c.kind === kind);
  });
  const targets = computed(() => targetsOf(seen, form.verb, form.service));

  function pickCapability(name: string) {
    form.capability = name;
    form.params = JSON.stringify(examples[name] ?? {}, null, 2);
  }

  /** The params as an object, or null (with the reason in `paramsError`). */
  function parsedParams(): Record<string, unknown> | null {
    try {
      const v: unknown = JSON.parse(form.params || '{}');

      if (!isObject(v)) {
        throw new Error('params must be a JSON object');
      }

      paramsError.value = '';

      return v;
    } catch (e) {
      paramsError.value = errorText(e);

      return null;
    }
  }

  watch(
    () => form.service,
    () => {
      const first = caps.value[0]?.name;

      if (first) {
        pickCapability(first);
      }
    },
  );
  watch(
    () => form.verb,
    () => {
      const named = (c: CapabilityInfo) => c.name === form.capability;
      const picksCapability = form.verb === 'ASK' || form.verb === 'INTENT';

      if (picksCapability && !caps.value.some(named) && caps.value[0]) {
        pickCapability(caps.value[0].name);
      }

      form.target = targets.value[0]?.value ?? '';
    },
  );
  watch(targets, (t) => {
    if (!t.some((x) => x.value === form.target)) {
      form.target = t[0]?.value ?? '';
    }
  });

  return { form, paramsError, caps, targets, pickCapability, parsedParams };
}
