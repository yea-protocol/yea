/**
 * The hero's examples: what the person asks their agent for, which example service it goes
 * to, and what to call the outcome. The page signs one policy for all of them (policy.ts),
 * and each lands somewhere different under it: dinner costs more than $40, so the shop asks;
 * the calendar rates cancelling a meeting as medium risk, over the policy's low-risk ceiling,
 * so it asks; moving a meeting is low risk and undoable, so it goes ahead.
 *
 * No runtime imports, so the recording script and the tests can load it under Node.
 */

export type SceneKey = 'dinner' | 'cancel' | 'move';

/** The example services, by the key the page loads them under. */
export type ServiceKey = 'shop' | 'calendar';

export interface Scene {
  key: SceneKey;
  /** The example's name, on its button. */
  label: string;
  /** What the person asked their agent for, in their words. */
  request: string;
  service: ServiceKey;
  /** The service's id, as the policy names it. */
  host: string;
  capability: string;
  /** The intent's params, for a request about `day` (tomorrow, in UTC). */
  params: (day: string) => Record<string, unknown>;
  /** Why the policy lets it through or stops it, in words. */
  why: string;
  /** What the person reads once it's committed, and once it's undone. */
  done: string;
  undone: string;
}

/** The order the agent places: four meals, over the policy's $40 per action. */
export const ORDER_ITEMS = [
  { sku: 'm047', qty: 2 },
  { sku: 'm055', qty: 2 },
];

export const SCENES: Record<SceneKey, Scene> = {
  dinner: {
    key: 'dinner',
    label: 'Order dinner',
    request: 'Order dinner for tomorrow',
    service: 'shop',
    host: 'shop.example',
    capability: 'shop.order',
    params: (day) => ({ items: ORDER_ITEMS, deliver: day }),
    why: 'It costs more than the $40 your policy allows per action.',
    done: 'Order placed.',
    undone: 'Order cancelled.',
  },
  cancel: {
    key: 'cancel',
    label: 'Cancel a meeting',
    request: "Cancel tomorrow's design review",
    service: 'calendar',
    host: 'calendar.example',
    capability: 'calendar.cancel',
    params: () => ({ event: 'Design review' }),
    why: 'The calendar rates cancelling as medium risk (it deletes the event and emails both attendees), and your policy allows low risk only.',
    done: 'Meeting cancelled.',
    undone: 'Meeting restored.',
  },
  move: {
    key: 'move',
    label: 'Move a meeting',
    request: 'Move my 1:1 with Ana earlier tomorrow',
    service: 'calendar',
    host: 'calendar.example',
    capability: 'calendar.reschedule',
    params: () => ({ event: '1:1 with Ana' }),
    why: "It's low risk and can be undone, which your policy allows.",
    done: 'Meeting moved.',
    undone: 'Meeting moved back.',
  },
};

/** The examples in the order the page offers them. */
export const SCENE_KEYS: readonly SceneKey[] = ['dinner', 'cancel', 'move'];

/** Tomorrow's date in UTC, the day each example is about. */
export const tomorrow = (now = Date.now()) =>
  new Date(now + 864e5).toISOString().slice(0, 10);
