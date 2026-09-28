Not affiliated with, endorsed by, or sponsored by Stripe, Inc. Stripe is a trademark of Stripe, Inc.

# @yea-protocol/stripe

An MCP server for the Stripe API, built on [`@yea-protocol/mcp`](../../mcp). It gives an agent
the jobs a support or finance person does, as tools that preview what they'll do, wait for
your approval, and can be undone where Stripe allows it.

| Tool | Kind | What it does |
|---|---|---|
| `customer` | read | Finds a customer by name, email or `cus_` id: their plan, renewal date, recent payments and what's refundable, in one call. |
| `refund` | job | Refunds a payment: all of it, an estimate of what's unused of their subscription, or an amount. By default it's their latest successful payment, never an older one. It can't be undone, so it always asks. |
| `cancel_subscription` | job | At period end (undoable until a day before it), or now (not undoable). |
| `change_plan` | job | At renewal (undoable until a day before it), or now with proration (not undoable). |

Each job returns its plans first: what changes, what money it spends, its risk and its undo
window. You approve in your MCP client by typing a phrase: the amount for a refund, or the
customer's email (their `cus_` id if they have no email) for a cancel or plan change. A client
that can't show a form gets a consent code for `yea approve` instead. Every job also takes
`"preview": true`, which shows the plans and does nothing.

## Install

In your MCP client's config, with `yea-stripe` as the server's key:

```json
{
  "mcpServers": {
    "yea-stripe": {
      "command": "npx",
      "args": ["-y", "@yea-protocol/stripe"],
      "env": {
        "STRIPE_SECRET_KEY_FILE": "/home/me/.config/yea/stripe.key",
        "YEA_PRINCIPAL_PUB": "/etc/yea/principal.pub"
      }
    }
  }
}
```

Or in Claude Code:

```sh
claude mcp add yea-stripe \
  -e STRIPE_SECRET_KEY_FILE=/home/me/.config/yea/stripe.key \
  -e YEA_PRINCIPAL_PUB=/etc/yea/principal.pub \
  -- npx -y @yea-protocol/stripe
```

Node 20 or later.

### The Stripe key

Put a [restricted key](#permissions) in a file that only you can read:

```sh
install -m 600 /dev/null ~/.config/yea/stripe.key
$EDITOR ~/.config/yea/stripe.key        # paste rk_test_… or rk_live_…
```

`STRIPE_SECRET_KEY_FILE` must name a regular file owned by the user the server runs as, with
mode `0600` (or `0400`). The server refuses a symlink, a file another user owns, or one that
group or others can read, and it doesn't fall back to anything else when the file is refused.
`STRIPE_SECRET_KEY` also works, for places where a file is awkward. On Windows, which has no
file owner or mode bits to check, the server warns and leaves keeping the file private to you.

The key is only ever sent to `api.stripe.com`, and never appears in a tool's output.

### Test and live mode

A key containing `_test_` is test mode. **Any other key is live**, so an unfamiliar format
fails toward caution. Every plan's summary starts with `[test]` or `[LIVE]`, and live mode
raises every plan's risk one level (see [Risk](#risk)). If Stripe's answer says the other mode
(its `livemode`), the server stops rather than go on under the wrong label.

### Your approvals

`YEA_PRINCIPAL_PUB` names a file holding your YEA public key (`yea whoami`). It must be out of
the agent's reach: neither the file nor any directory above it may be owned by or writable by
the server's user. Without it nothing auto-runs and no consent code is accepted, so every job
asks in the form, or fails closed.

## Permissions

Use a restricted key (`rk_…`) with only these permissions:

| Stripe permission | Access | Used for |
|---|---|---|
| Customers (`customer_read`) | Read | finding customers |
| Charges and Refunds (`charge_write`) | Write | reading payments, and refunds (Stripe has no separate refund permission) |
| Subscriptions (`subscription_write`) | Write | reading, cancelling and changing subscriptions |
| Prices (`plan_read`) | Read | the price a plan change moves to |
| Invoices (`invoice_read`) | Read | previewing a prorated change |
| Subscription schedules | Write, **to be confirmed** | "at renewal" changes, and cancelling a scheduled subscription. Stripe's docs don't say whether schedules need their own permission or come with Subscriptions; the test-mode smoke test confirms it before release. |

There's no up-front check: Stripe has no API that lists a key's permissions. When a call needs
one the key lacks, the tool returns Stripe's error, which names the missing permission, and
nothing runs.

## Policy

By default every job asks. A signed policy grant lets undoable, low-risk plans run on their
own. Find the server's key, then grant it:

```sh
npx -y @yea-protocol/stripe --service-key          # ed25519:…
yea grant --to <server key> --can cancel_subscription --can change_plan --risk low --exp 30d
```

Point `YEA_POLICY` at the grant (a file holding the `pg1.` token, or the token itself). What
it does:

- **In test mode,** it auto-runs "cancel at period end" and a cheaper-or-same "change plan at
  renewal": the undoable, low-risk plans. Everything else asks.
- **In live mode,** those plans are `medium`, so this grant auto-runs nothing. `--risk medium`
  would auto-run them in live mode too: make that choice deliberately.
- **Refunds and immediate changes never auto-run,** whatever the grant says: they can't be
  undone.
- **No money limit is suggested.** None of the plans that can auto-run spend money, so an
  `--each spend=…` limit would limit nothing.

Unsigned rules in `~/.yea/policy.json` can only tighten this, for example
`{ "deny": ["refund"] }`.

### Risk

| Plan | Test mode | Live mode |
|---|---|---|
| `refund` | medium | high |
| `cancel_subscription` now | medium | high |
| `cancel_subscription` at period end | low | medium |
| `change_plan` now (charges or credits) | medium | high |
| `change_plan` at renewal, cheaper or same price | low | medium |
| `change_plan` at renewal, dearer, or not comparable | medium | high |

"Cheaper or same" means both prices are flat per-unit prices in the same currency and billing
interval, with the same quantity, and the new unit amount is no higher. Anything else (tiered
or metered prices, say) can't be compared, so it counts as dearer.

`high` plans are never offered in the client's form: they need `yea approve <code>` in your
terminal.

### What money it reports

A plan's `uses.spend` is money leaving the business: a refund, or the credit a prorated
downgrade puts on the customer's balance. A prorated charge to the customer spends nothing.
Amounts follow Stripe's currency rules (zero-decimal currencies, three-decimal ones, and ISK
and UGX), and amounts you pass in are strings, like `"12.50"`.

## The threat model

**Whatever the server can read, an agent running as the same OS user can read too.** A Stripe
key lets whoever holds it call Stripe directly and skip every approval. The key file's mode
stops *other* users on the machine, not an agent running as you.

So, for live keys, **run the server as a separate OS user** (or on another machine, over
`--http`), and keep the key file and your `YEA_PRINCIPAL_PUB` out of the agent's user's reach.
With a test key the worst case is test data.

What the server does enforce, whoever calls it:
- writes happen only after a plan is approved or allowed by your signed policy, and each
  approval runs once;
- every write carries a fresh idempotency key, so a retry never refunds twice and a deliberate
  second refund is never silently skipped;
- customer names and emails are shown quoted, capped at 80 characters, with control and
  direction-changing characters escaped, so a customer can't forge what you approve;
- the Stripe API version is pinned (`2026-08-26.dahlia`);
- the key, and anything that looks like a Stripe key, is taken out of every error message.

## Over HTTP

```sh
YEA_HTTP_TOKEN=$(openssl rand -hex 32) YEA_SUB=me@example.com \
  STRIPE_SECRET_KEY_FILE=… YEA_PRINCIPAL_PUB=… \
  npx -y @yea-protocol/stripe --http 8787            # --host 0.0.0.0 to listen beyond loopback
```

Streamable HTTP serves one person. Every request must carry `Authorization: Bearer
$YEA_HTTP_TOKEN`, and a request that does is `YEA_SUB`. On loopback the `Host` header is
checked too. **The server speaks plain HTTP:** off loopback, put TLS in front of it (a reverse
proxy such as Caddy or nginx), or the bearer token crosses the network in the clear. Approvals live in memory, where `yea approve` can't reach them, so **live `high`
plans (refunds, immediate changes) can't run over HTTP at all**: use stdio for those.

## What it does in Stripe

| Plan | Requests |
|---|---|
| refund | `POST /v1/refunds` with `payment_intent` and `amount`. Without `payment`, the latest successful payment; if that's fully refunded, the call is refused, naming the refunds already made, rather than moving to an older one. On a payment already partly refunded, the plan says how much and when, and the phrase to type ends in "again". "What's unused" is an estimate from the subscription's period, of what was paid less what's already refunded, and says so. |
| cancel at period end | `POST /v1/subscriptions/:id` `cancel_at_period_end=true`; undo sets it back. On a scheduled subscription, the schedule's `end_behavior` becomes `cancel`; undo sets it back to `release`. |
| cancel now | `DELETE /v1/subscriptions/:id` |
| change now | `POST /v1/subscriptions/:id` with the new price, `proration_behavior=always_invoice` and `payment_behavior=pending_if_incomplete`, at the proration date the plan previewed with `POST /v1/invoices/create_preview`. The plan shows what's charged after the customer's credit balance. If the payment fails, the call says the change is pending, not made: Stripe discards it after about 23 hours if the invoice isn't paid, and the old price stays on. |
| change at renewal | `POST /v1/subscription_schedules` from the subscription, then its phases: the current one as it is, and the new price from the renewal date. If the second write fails, the schedule is released; if that fails too, the error names the schedule left behind. Undo releases it. |

Plans only read (and preview); every write happens after approval. A plan measures time from
the start of today (UTC), so it stays the same while you decide, and changes at midnight.

**Not in this version:** subscriptions with more than one item, price changes that alter the
billing interval or currency, inactive prices, customers with more than 100 subscriptions
(unless you name the `sub_` id), and "at renewal" on a subscription that already has a
schedule, has discounts, or has any of automatic tax, custom invoice settings, billing
thresholds, `on_behalf_of`, `transfer_data`, an application fee or pending invoice items
(the schedule copy can't carry those yet).

## As a library

```ts
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { yea } from '@yea-protocol/mcp';
import { stripeServer } from '@yea-protocol/stripe';

const approvals = yea({ name: 'yea-stripe', transport: 'stdio' });

serveStdio(stripeServer({ key: process.env.STRIPE_SECRET_KEY ?? '', approvals }));
```

`@yea-protocol/stripe/api` is the dependency-free Stripe client and readers on their own.

## License

Apache-2.0
