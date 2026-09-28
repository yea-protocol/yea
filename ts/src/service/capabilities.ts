/** A service's registered capabilities: the list HELLO shows, and the error for a name that isn't one. */
import { fix, YeaError } from '../errors.js';
import type { CapabilityInfo } from '../types.js';
import { closest } from '../validate.js';
import type { ServiceState } from './state.js';

type Registry = Pick<ServiceState, 'asks' | 'intents'>;

/** Every capability, asks first, as a BRIEF lists them. */
export function listCapabilities(state: Registry): CapabilityInfo[] {
  const out: CapabilityInfo[] = [];

  for (const [name, d] of state.asks) {
    out.push({
      name,
      kind: 'ask',
      summary: d.summary,
      ...(d.params ? { params: d.params } : {}),
    });
  }

  for (const [name, d] of state.intents) {
    out.push({
      name,
      kind: 'intent',
      summary: d.summary,
      ...(d.params ? { params: d.params } : {}),
      ...(d.risk ? { risk: d.risk } : {}),
    });
  }

  return out;
}

/** Throw `unknown_capability`, naming the right verb or the closest name. */
export function unknownCapability(
  state: Registry,
  name: unknown,
  kind: 'ask' | 'intent',
): never {
  const all = [...state.asks.keys(), ...state.intents.keys()];
  const other =
    kind === 'ask'
      ? state.intents.has(String(name))
      : state.asks.has(String(name));

  if (other) {
    const verb = kind === 'ask' ? 'INTENT' : 'ASK';

    throw new YeaError(
      'unknown_capability',
      `${name} is ${kind === 'ask' ? 'an intent' : 'an ask'} capability`,
      { fix: [fix(`send it with ${verb}`)] },
    );
  }

  const near = closest(String(name), all);

  throw new YeaError(
    'unknown_capability',
    `no capability named ${JSON.stringify(name)}`,
    {
      fix: near
        ? [fix(`did you mean ${near}?`)]
        : [fix(`send HELLO to list capabilities (${all.length} available)`)],
    },
  );
}
