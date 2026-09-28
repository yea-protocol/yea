/**
 * Test harness: a fake Stripe, a clock the tests move, the jobs' context, and for MCP tests the
 * server over them in a temp YEA home with a pinned principal, and the README's suggested grant.
 * The MCP clients, approval and grant install are @yea-protocol/mcp's test harness, imported by
 * path (connector → mcp is the allowed direction).
 */
import type { McpServer } from '@modelcontextprotocol/server';
import { type Approvals, yea } from '@yea-protocol/mcp';
import { type Caveat, hashPlans, type JobPlan } from '@yea-protocol/sdk';
import { expect } from 'vitest';
import {
  freshHome,
  type Home,
  tmp as harnessTmp,
  installGrant,
} from '../../../mcp/test/harness.js';
import type { Ctx, JobSpec } from '../src/context.js';
import { contextFor, stripeServer } from '../src/server.js';
import {
  D,
  type FakeState,
  type FakeStripe,
  fakeStripe,
} from './fake-stripe.js';

export {
  accept,
  approve,
  connect,
  type Kind,
  textOf,
} from '../../../mcp/test/harness.js';

/** Sunday 2026-09-27, 10:00 UTC. */
export const NOW = Date.UTC(2026, 8, 27, 10) / 1000;

export const TEST_KEY = 'sk_test_51abcDEF';
export const LIVE_KEY = 'sk_live_51abcDEF';

export { D };

export const tmp = () => harnessTmp('yea-stripe-');

export interface Setup {
  stripe: ReturnType<typeof fakeStripe>;
  ctx: Ctx;
  clock: { now: number };
}

/** A fake Stripe and the jobs' context over it, at `NOW`. */
export function setup(
  o: {
    live?: boolean;
    declines?: boolean;
    state?: (s: FakeState) => Partial<FakeState>;
  } = {},
): Setup {
  const stripe = fakeStripe({
    now: NOW,
    declines: o.declines ?? false,
    livemode: o.live ?? false,
    ...(o.state ? { state: o.state } : {}),
  });
  const clock = { now: NOW };
  const ctx = contextFor({
    key: o.live ? LIVE_KEY : TEST_KEY,
    fetch: stripe.fetch,
    now: () => clock.now,
  });

  return { stripe, ctx, clock };
}

/** A version 4 UUID, as `randomUUID()` makes. */
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * Every write so far carried the connector's own idempotency key: a UUIDv4, never the SDK's
 * `stripe-node-retry-…` one, and a different one for each write. (The fake refuses an
 * `idempotencyKey` sent as a parameter, as Stripe does, so a key in the wrong argument fails.)
 */
export function expectOwnFreshKeys(stripe: FakeStripe) {
  const keys = stripe.writes().map((w) => w.key);

  expect(keys.length).toBeGreaterThan(0);

  for (const key of keys) {
    expect(key).toMatch(UUID_V4);
  }

  expect(new Set(keys).size).toBe(keys.length);
}

/** A job's plans, or throw if it asked a question instead. */
export async function plansOf<I>(
  spec: JobSpec<I>,
  input: I,
): Promise<JobPlan[]> {
  const out = await spec.plan(input);

  if (!Array.isArray(out)) {
    throw new Error(`expected plans, got ${JSON.stringify(out)}`);
  }

  return out;
}

/** The plan hashes the approval core would compute. */
export async function hashesOf<I>(spec: JobSpec<I>, input: I) {
  const plans = await plansOf(spec, input);
  const hashed = await hashPlans(
    { name: spec.name, risk: spec.risk, revert: spec.revert },
    input,
    plans,
  );

  return hashed.map((h) => h.planHash);
}

export interface World extends Setup, Home {
  approvals: Approvals;
  factory: () => McpServer;
}

/** A temp YEA home and store, a pinned principal, and the server over a fake Stripe. */
export async function world(
  o: { live?: boolean; state?: (s: FakeState) => Partial<FakeState> } = {},
): Promise<World> {
  const h = await freshHome('yea-stripe-');
  const approvals = yea({
    name: 'yea-stripe',
    transport: 'stdio',
    store: h.store,
    principal: h.principal.public,
  });
  const s = setup(o);
  const factory = stripeServer({
    key: o.live ? LIVE_KEY : TEST_KEY,
    approvals,
    fetch: s.stripe.fetch,
    now: () => s.clock.now,
  });

  return { ...s, ...h, approvals, factory };
}

/**
 * The README's suggested grant:
 * `yea grant --to <server key> --can cancel_subscription --can change_plan --risk low --exp 30d`.
 */
export const suggestedGrant = (
  w: World,
  caveats: Caveat[] = [
    { can: ['cancel_subscription', 'change_plan'] },
    { risk: 'low' },
  ],
): Promise<string> => installGrant(w, caveats, 30 * D);
