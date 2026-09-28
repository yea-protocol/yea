/**
 * Retries without the wait, so the suite stays fast. The SDK's backoff comes from two methods
 * that stripe-node doesn't document (checked against 22.x); stubbing them to 0 leaves its
 * retry decisions and key reuse running for real, only the sleeps between tries go.
 */
import Stripe from 'stripe';

for (const name of [
  'getInitialNetworkRetryDelay',
  'getMaxNetworkRetryDelay',
] as const) {
  // Loudly, so a rename in the SDK can't quietly bring the waits back.
  if (typeof Stripe.prototype[name] !== 'function') {
    throw new Error(`stripe no longer has ${name}; update test/setup.ts`);
  }

  Stripe.prototype[name] = () => 0;
}
