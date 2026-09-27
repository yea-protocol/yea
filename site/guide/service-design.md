# From REST to YEA

**The short version:** in REST, the agent works out *how* to do a job, one call at a time. In YEA, the agent says *what* it wants, and your service answers with ready-made plans: what will happen, what it costs, and whether it can be undone. This page shows how to turn a REST API into that, using a Stripe-backed billing API as the example.

## One job, both ways

A customer writes to support: *"Please refund the rest of this month, I'm cancelling."*

<div class="side-by-side">
<div>

**REST: the agent makes four calls and does the math**

```http
GET  /v1/customers/search?query=name:"Chen"
GET  /v1/subscriptions?customer=cus_chen
GET  /v1/charges?customer=cus_chen&limit=5
POST /v1/refunds
     charge=ch_2  amount=2287
```

Nothing tells the agent that a refund is permanent, or that the customer gets an email.

</div>
<div>

**YEA: the agent makes one call and picks a plan**

```text
INTENT billing.refund {who: "Chen"}

2 proposals — risk: medium · undo: never
[p_tJnW1A-y] Refund 49.00 USD of ch_2 to Chen Wei (full)
  ~ update charge/ch_2.amount_refunded: 0.00 USD → 49.00 USD
  > send chen@wei.studio — refund receipt; back on the card in 5–10 days
  uses: spend 49.00 USD
[p_VPlXarXR] Refund 22.87 USD of ch_2 to Chen Wei (unused 14 days)
  …
  uses: spend 22.87 USD
```

The agent commits the second plan. Because it can't be undone, the human's policy decides whether the agent may do that alone.

</div>
</div>

::: info Why not just wrap the REST API?
You can: [`yea openapi`](/guide/openapi) gives any REST API YEA's safety in one command. But the agent still makes every call itself, and each call is another model turn, which is where most of an agent's cost goes ([live eval](/benchmark/live)). A native service takes those turns away.
:::

## The cheat sheet

| In your REST API | In YEA |
|---|---|
| Several `GET`s that answer one question | One `ASK` |
| A `POST`, `PATCH` or `DELETE` | An `INTENT` that returns plans, then `COMMIT` |
| The write call itself | The plan's `apply()` |
| The call that reverses it, if any | The plan's `revert()`, which makes the plan undoable |
| Side effects your docs mention ("sends a receipt") | The plan's `effects`, shown to the agent and the human |
| Two endpoints for two ways of doing one job | Two plans from one intent |
| Ids like `cus_NffrFeUfNV2Hib` | Names or emails, resolved by your service |
| `4xx` errors | Errors that say how to fix the request |

## Five steps

### 1. Start from what users say, not from your endpoints

Write down the requests people make, then find the endpoints each one needs. Each request becomes one capability.

| What the user says | Stripe endpoints today | YEA |
|---|---|---|
| "What's going on with Chen's account?" | `GET` customers, subscriptions, charges | `ASK billing.customer {who}` |
| "Refund Chen's last payment" | the three `GET`s, then `POST /v1/refunds` | `INTENT billing.refund {who}` |
| "Cancel Chen at the end of the month" | `POST /v1/subscriptions/:id` `cancel_at_period_end=true` | `INTENT billing.cancel {who}`, plan 1 |
| "Cancel Chen right now" | `DELETE /v1/subscriptions/:id` | `INTENT billing.cancel {who}`, plan 2 |
| "Actually, keep Chen's subscription" | `POST /v1/subscriptions/:id` `cancel_at_period_end=false` | `UNDO` the cancel. Nothing to build |

Five requests, eight endpoints, three capabilities. Endpoints agents shouldn't touch, like API keys or webhooks, are simply left out.

### 2. Turn reads into ASKs

One `ASK` makes the REST calls it needs and returns only what an agent needs to answer the question.

<div class="side-by-side">
<div>

**REST: three responses, abridged**

```json
{ "data": [{
    "id": "cus_chen", "object": "customer",
    "email": "chen@wei.studio", "name": "Chen Wei",
    "created": 1680893993, "invoice_settings": { … }, …
}]}
{ "data": [{
    "id": "sub_chen",
    "items": { "data": [{
      "current_period_end": 1791504000,
      "price": { "id": "price_1Mo…", … }, …
}]}
{ "data": [{
    "id": "ch_2", "amount": 4900, "amount_refunded": 0,
    "billing_details": { … }, "outcome": { … }, …
```

</div>
<div>

**YEA: what the agent reads**

```text
id: cus_chen
name: Chen Wei
email: chen@wei.studio
plan: pro
renews: 2026-10-09
payments[2]{id,date,amount,refunded,status}:
  ch_2,2026-09-09,49.00 USD,0.00 USD,succeeded
  ch_1,2026-08-10,49.00 USD,0.00 USD,succeeded
```

</div>
</div>

- **Accept names and emails,** and resolve them in the service.
- **Return readable values:** dates, not timestamps; `49.00 USD`, not `4900`.
- **Keep rows flat,** so they render as a table.
- **Don't paginate.** YEA trims long lists to the agent's [budget](/guide/budgets) for you.

::: details The code for this ASK
<<< ../../examples/stripe-billing.ts#ask
:::

### 3. Turn writes into INTENTs

An intent returns one or more **plans**. You fill in a plan from what you already know about the REST call:

| Plan field | What goes in it | For a refund |
|---|---|---|
| `summary` | One line a person would read | `Refund 22.87 USD of ch_2 to Chen Wei` |
| `effects` | Everything the call changes, including emails | the charge, and the receipt email |
| `uses` | What it uses up, such as the money it moves | `spend 22.87 USD` |
| `apply()` | The REST call | `POST /v1/refunds` |
| `revert()` | The call that reverses it, if one exists | none, so `undo: never` |

<<< ../../examples/stripe-billing.ts#refund-plan

When a reverse call exists, `revert()` makes it, and the plan becomes undoable. Cancelling at the end of the month is undone by setting `cancel_at_period_end` back to `false`:

<<< ../../examples/stripe-billing.ts#cancel-plan

- **List every effect.** The human approves what the plan says, so `apply()` must do nothing more.
- **Add `revert()` only if it really restores the old state.** YEA only commits undoable plans automatically.
- **Offer the choices a person would,** like "full or unused days" and "now or at period end". Put the safest common choice first.

### 4. Make errors say how to fix the request

| When | YEA error | Include |
|---|---|---|
| Params are out of range | `invalid_params` | A fix: `refund the rest (49.00 USD) → {"amount":49}` |
| A name matches several records | `CLARIFY` | One option per match |
| `404` | `not_found` | Which `ASK` would find it |
| `429` or `5xx` | `limit` or `unavailable` | When to retry |

### 5. Skip the plumbing

Idempotency, pagination, confirmation screens and permission checks are part of the protocol. You don't build them. See [Build a service](/guide/build-a-service) for the library API.

## The full example

[`examples/stripe-billing.ts`](../../examples/stripe-billing.ts) puts these three capabilities in front of the real Stripe API. Try it with a test-mode key:

```sh
export STRIPE_SECRET_KEY=sk_test_…
export YEA_TRUST="$(yea whoami | awk '/principal/{print $2}')"
node examples/stripe-billing.ts
yea add yea://127.0.0.1:7453   # now your AI tool can use it
```

The [playground](/playground) runs the same design with made-up data, no key needed.

::: details Show the full file
<<< ../../examples/stripe-billing.ts
:::

## Checklist

- [ ] Each capability is something a user would ask for
- [ ] Names and emails work wherever ids do
- [ ] Each `ASK` answers a whole question in one call
- [ ] `apply()` makes the REST call; `revert()` reverses it, or doesn't exist
- [ ] Every plan lists all its effects and what it really uses
- [ ] Choices are separate plans, safest first
- [ ] Every error says how to fix the request
