/**
 * `@yea-protocol/stripe`: an MCP server for the Stripe API, built on `@yea-protocol/mcp`
 * (docs/framework/SPEC-connector-stripe.md). Four tools: `customer`, and the jobs `refund`,
 * `cancel_subscription` and `change_plan`, each previewed, approved and, where Stripe allows,
 * undoable. Not affiliated with, endorsed by, or sponsored by Stripe, Inc.
 */
export {
  currentSubscriptions,
  findCustomers,
  isLiveKey,
  period,
  recentCharges,
  STRIPE_VERSION,
  type StripeApi,
  StripeError,
  type StripeOptions,
  stripeApi,
  subscriptionPage,
} from './api.js';

export { cheaperOrSame } from './change.js';

export { type Ctx, type JobSpec, riskFor, startOfDay } from './context.js';

export {
  formatMoney,
  parseMoney,
  scaleOf,
  stepOf,
  toQuantity,
} from './currency.js';

export { httpApp, httpAuthFrom, subOf } from './http.js';

export { readKeyFile, readSecretKey } from './key.js';

export {
  addStripeTools,
  type ConnectorOptions,
  contextFor,
  NAME,
  stripeServer,
  VERSION,
} from './server.js';

export { quoted, safeText } from './text.js';
