/**
 * Stripe, as this connector calls it (the `./api` export): the client in `api/client.ts`, its
 * failures in `api/errors.ts`, and the readers `examples/stripe-billing.ts` shares in
 * `api/reads.ts`.
 */

export {
  isLiveKey,
  STRIPE_VERSION,
  type Stripe,
  type StripeApi,
  type StripeOptions,
  stripeApi,
} from './api/client.js';

export { errorMessage, redactKeys, StripeError } from './api/errors.js';

export {
  cancelling,
  currentSubscription,
  currentSubscriptions,
  findCustomers,
  idOf,
  period,
  recentCharges,
  SCHEDULE_ID,
  SUB_ID,
  subscriptionPage,
} from './api/reads.js';
