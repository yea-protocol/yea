/**
 * The playground's shared shapes: the example services it runs, the verbs you can send,
 * the request form, and one recorded exchange (request, reply and events); plus the two
 * small helpers every part uses (one value per service, and an error's message).
 */
import type {
  Event,
  FinalReply,
  KeyPair,
  Request,
  Verb,
} from '@yea-protocol/sdk';

/** The SDK module, loaded in the browser when the playground mounts. */
export type Core = typeof import('@yea-protocol/sdk');

/** The playground's name for each example service. */
export type ServiceKey = 'calendar' | 'shop' | 'billing';

/** The verbs that pick an earlier proposal, receipt or handle. */
export type TargetVerb = 'COMMIT' | 'UNDO' | 'EXPAND';

/** The human's key and the agent's key. */
export interface Keys {
  principal: KeyPair;
  agent: KeyPair;
}

/** What the agent is about to send. */
export interface RequestForm {
  service: ServiceKey;
  verb: Verb;
  capability: string;
  params: string;
  goal: string;
  auto: boolean;
  useBudget: boolean;
  budget: number;
  target: string;
}

/** One request and what came back, as the transport saw it. */
export interface Exchange {
  n: number;
  service: ServiceKey;
  request: Request;
  reply: FinalReply;
  events: Event[];
  ms: number;
  auto: boolean;
}

/** Each service's audience id. */
export const SERVICES: Record<ServiceKey, string> = {
  calendar: 'calendar.example',
  shop: 'shop.example',
  billing: 'billing.example',
};

export const SERVICE_KEYS: readonly ServiceKey[] = [
  'calendar',
  'shop',
  'billing',
];

export const VERBS: readonly Verb[] = [
  'HELLO',
  'ASK',
  'INTENT',
  'COMMIT',
  'UNDO',
  'EXPAND',
];

/** One value per service, built in the order calendar, shop, billing. */
export const perService = <T>(
  make: (s: ServiceKey) => T,
): Record<ServiceKey, T> => {
  const calendar = make('calendar');
  const shop = make('shop');
  const billing = make('billing');

  return { calendar, shop, billing };
};

/** A thrown value's message, as the playground shows it. */
export function errorText(e: unknown): string {
  if (
    typeof e === 'object' &&
    e !== null &&
    'message' in e &&
    e.message != null
  ) {
    return String(e.message);
  }

  return String(e);
}
