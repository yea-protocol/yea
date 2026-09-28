/**
 * Retries without the wait, so the suite stays fast. The SDK's backoff comes from two methods
 * that stripe-node doesn't document (checked against 22.x); stubbing them to 0 leaves its
 * retry decisions and key reuse running for real, only the sleeps between tries go.
 */
import Stripe from 'stripe';

Stripe.prototype.getInitialNetworkRetryDelay = () => 0;
Stripe.prototype.getMaxNetworkRetryDelay = () => 0;
