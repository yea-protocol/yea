/**
 * The playground, composed: it loads the SDK and the example services in the page, then
 * wires the log, the grant, the request form, sending, the shortcuts and consent together.
 */
import type { Service } from '@yea-protocol/sdk';
import { nextTick, onMounted, ref, type ShallowRef, shallowRef } from 'vue';
import { type Core, errorText, type Keys, type ServiceKey } from './model';
import { examples as makeExamples } from './presets';
import { useConsent } from './use-consent';
import { useExchanges } from './use-exchanges';
import { useGrant } from './use-grant';
import { useRequestForm } from './use-request-form';
import { useSend } from './use-send';
import { useShortcuts } from './use-shortcuts';

/** Load the SDK and the example services' modules. */
const loadModules = () =>
  Promise.all([
    import('@yea-protocol/sdk'),
    import('@examples/calendar.ts'),
    import('@examples/shop.ts'),
    import('@examples/billing.ts'),
  ]);

type Modules = Awaited<ReturnType<typeof loadModules>>;

/** What starting the playground fills in, in this order. */
interface Runtime {
  core: ShallowRef<Core | null>;
  keys: ShallowRef<Keys | null>;
  services: ShallowRef<Record<ServiceKey, Service> | null>;
}

/** Start the three example services, each trusting the human's key. */
function startServices(
  [, cal, sh, bi]: Modules,
  principal: string,
): Record<ServiceKey, Service> {
  return {
    calendar: cal.calendar({ trust: [principal] }),
    shop: sh.shop({ trust: [principal] }),
    billing: bi.billing({ trust: [principal] }),
  };
}

/** Load the SDK, make the keys and start the services; the page shows the panes once `core` is set. */
async function start({ core, keys, services }: Runtime): Promise<void> {
  const modules = await loadModules();
  const sdk = modules[0];

  core.value = sdk;

  const [principal, agent] = await Promise.all([sdk.keyPair(), sdk.keyPair()]);

  keys.value = { principal, agent };
  services.value = startServices(modules, principal.public);
}

/** Consent's state and action, named as consent's so they sit flat beside the rest. */
const consentFields = (c: ReturnType<typeof useConsent>) => ({
  consentRequest: c.request,
  consentMessage: c.message,
  consentFacts: c.facts,
  consentCheck: c.check,
  approveConsent: c.approve,
});

interface OpenDeps {
  runtime: Runtime;
  rebuild: () => Promise<void>;
  send: () => Promise<void>;
}

/** On mount: start everything, sign the grant and open on a real exchange; `opened` then turns true. */
function openOnMount({ runtime, rebuild, send }: OpenDeps) {
  const failed = ref('');
  const opened = ref(false);

  onMounted(async () => {
    try {
      await start(runtime);
      await rebuild();
      await nextTick();
      await send();
      opened.value = true;
    } catch (e) {
      failed.value = errorText(e);
    }
  });

  return { failed, opened };
}

export function usePlayground() {
  const runtime: Runtime = {
    core: shallowRef(null),
    keys: shallowRef(null),
    services: shallowRef(null),
  };
  const { core, keys, services } = runtime;
  const examples = makeExamples();
  const exchanges = useExchanges(services);
  const { current, seen, selected } = exchanges;
  const grants = useGrant({ core, keys, transportFor: exchanges.transportFor });
  const request = useRequestForm({ services, seen, examples });
  const { form, parsedParams } = request;
  const { busy, send } = useSend({
    clients: grants.clients,
    form,
    seen,
    parsedParams,
    selected,
    markAuto: exchanges.markAuto,
  });
  const shortcuts = useShortcuts({ form, current, examples, send });
  const consent = useConsent({ core, keys, current, seen, act: shortcuts.act });

  const { failed, opened } = openOnMount({
    runtime,
    rebuild: grants.rebuild,
    send,
  });

  return {
    core,
    failed,
    opened,
    log: exchanges.log,
    selected,
    current,
    busy,
    send,
    policy: grants.policy,
    grant: grants.grant,
    grantInfo: grants.grantInfo,
    form,
    paramsError: request.paramsError,
    caps: request.caps,
    targets: request.targets,
    pickCapability: request.pickCapability,
    parsedParams,
    act: shortcuts.act,
    choose: shortcuts.choose,
    runPreset: shortcuts.runPreset,
    ...consentFields(consent),
  };
}
