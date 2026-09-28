/** The made-up customers behind the billing example: plans and prices, payments, and the seed. */

export type PlanId = 'starter' | 'pro' | 'team';

export const PRICES: Record<PlanId, number> = {
  starter: 1900,
  pro: 4900,
  team: 9900,
};

export const DAY = 86400_000;

export interface Payment {
  id: string;
  at: number;
  amount: number;
  status: 'paid' | 'failed';
  refunded: number;
}

export interface Customer {
  id: string;
  name: string;
  email: string;
  plan: PlanId;
  status: 'active' | 'past_due' | 'canceled';
  card: string;
  renews: number;
  cancelAt: number | null;
  nextPlan: PlanId | null;
  payments: Payment[];
}

export const usd = (cents: number) => `${(cents / 100).toFixed(2)} USD`;
export const date = (ms: number) => new Date(ms).toISOString().slice(0, 10);

interface Seed
  extends Pick<Customer, 'id' | 'name' | 'email' | 'plan' | 'card'> {
  renewsInDays: number;
  lastFailed?: boolean;
}

const SEED: Seed[] = [
  {
    id: 'cus_ana_r',
    name: 'Ana Ruiz',
    email: 'ana.ruiz@acme.co',
    plan: 'pro',
    renewsInDays: 21,
    card: 'visa ••4242',
  },
  {
    id: 'cus_ana_l',
    name: 'Ana Li',
    email: 'ana@northwind.io',
    plan: 'team',
    renewsInDays: 9,
    card: 'amex ••1005',
  },
  {
    id: 'cus_ben',
    name: 'Ben Okafor',
    email: 'ben@okafor.dev',
    plan: 'starter',
    renewsInDays: 3,
    card: 'visa ••0341',
    lastFailed: true,
  },
  {
    id: 'cus_chen',
    name: 'Chen Wei',
    email: 'chen@wei.studio',
    plan: 'pro',
    renewsInDays: 14,
    card: 'mc ••7730',
  },
  {
    id: 'cus_dana',
    name: 'Dana Park',
    email: 'dana@park.io',
    plan: 'team',
    renewsInDays: 27,
    card: 'visa ••9921',
  },
];

export function seedCustomers(now: number): Customer[] {
  let seq = 100;

  return SEED.map(({ renewsInDays, lastFailed = false, ...c }) => {
    const renews = now + renewsInDays * DAY;
    // Three monthly payments, the latest at the start of the current period.
    const payments = [2, 1, 0].map((k): Payment => {
      seq += 1;

      return {
        id: `pay_${seq}`,
        at: renews - (k + 1) * 30 * DAY,
        amount: PRICES[c.plan],
        status: k === 0 && lastFailed ? 'failed' : 'paid',
        refunded: 0,
      };
    });

    return {
      ...c,
      status: lastFailed ? 'past_due' : 'active',
      renews,
      cancelAt: null,
      nextPlan: null,
      payments,
    };
  });
}
