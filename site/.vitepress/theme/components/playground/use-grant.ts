/**
 * The human's policy, kept as a real grant: every change re-signs it with the human's key
 * and gives the agent a fresh client per service that presents it.
 */
import type { Client, GrantInfo, Transport } from '@yea-protocol/sdk';
import { reactive, ref, type ShallowRef, shallowRef, watch } from 'vue';
import { caveatsFor, type PolicyForm } from './grant';
import { type Core, type Keys, perService, type ServiceKey } from './model';

interface GrantDeps {
  core: ShallowRef<Core | null>;
  keys: ShallowRef<Keys | null>;
  /** The transport a client for `service` sends through. */
  transportFor: (service: ServiceKey) => Transport;
}

/** How long the policy must stay still before the grant is re-signed. */
const DEBOUNCE_MS = 250;

export function useGrant({ core, keys, transportFor }: GrantDeps) {
  const policy = reactive<PolicyForm>({
    calendar: true,
    shop: true,
    billing: true,
    risk: 'low',
    each: '40',
    total: '100',
    exp: '8h',
  });
  const grant = ref('');
  const grantInfo = ref<GrantInfo | null>(null);
  const clients = shallowRef<Record<ServiceKey, Client> | null>(null);

  async function rebuild(): Promise<void> {
    const sdk = core.value;
    const k = keys.value;

    if (!sdk || !k) {
      return;
    }

    grant.value = await sdk.issueGrant({
      principal: k.principal,
      to: k.agent.public,
      caveats: caveatsFor(policy),
    });
    grantInfo.value = await sdk.inspectGrant(grant.value);

    const token = grant.value;

    clients.value = perService(
      (s) =>
        new sdk.Client(transportFor(s), {
          key: k.agent.seed,
          grants: [token],
          name: 'playground',
        }),
    );
  }

  let pending: ReturnType<typeof setTimeout> | undefined;

  watch(policy, () => {
    if (!core.value) {
      return;
    }

    clearTimeout(pending);
    pending = setTimeout(() => void rebuild(), DEBOUNCE_MS);
  });

  return { policy, grant, grantInfo, clients, rebuild };
}
