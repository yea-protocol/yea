# From REST to YEA

**The short version:** in REST, the agent works out *how* to do a job, one call at a time. In YEA, the agent says *what* it wants, and your tool answers with ready-made plans: what will happen, what it costs, and whether it can be undone. The person approves a plan, or their signed policy lets it run. This page shows how to turn a REST API into that, using a Stripe-backed billing API as the example.

The example is an MCP server built with `@yea-protocol/mcp` ([Add YEA to your MCP server](/guide/mcp-typescript)). If you're implementing the YEA protocol itself, the same design as a protocol service is [at the end](#implementing-the-protocol-the-same-design-as-a-service).

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

**YEA: the agent makes one call, and the person picks a plan**

```text
refund {"who": "Chen"}

Approval needed: refund can't be undone.

[1] Refund 49.00 USD of ch_2 to Chen Wei (full)
  ~ update charge/ch_2.amount_refunded: 0.00 USD → 49.00 USD
  > send chen@wei.studio — refund receipt; back on the card in 5–10 days
  uses: spend 49.00 USD · risk: medium · undo: never
[2] Refund 22.87 USD of ch_2 to Chen Wei (unused 14 days)
  …
  uses: spend 22.87 USD · risk: medium · undo: never
```

The person picks the second plan in their client and confirms it. A refund can't be undone, so it always asks: no policy lets it run on its own.

</div>
</div>

::: info Why not just wrap the REST API?
You can: [`yea openapi`](/guide/openapi) gives any REST API YEA's safety in one command. But the agent still makes every call itself, and each call is another model turn, which is where most of an agent's cost goes ([live eval](/benchmark/live)). Outcome-level tools take those turns away.
:::

## The cheat sheet

| In your REST API | With YEA |
|---|---|
| Several `GET`s that answer one question | One read-only tool |
| A `POST`, `PATCH` or `DELETE` | A `job()` tool that returns plans |
| The write call itself | The plan's `apply()` |
| The call that reverses it, if any | The job's `revert()`, which makes plans with an `undoWindow` undoable |
| Side effects your docs mention ("sends a receipt") | The plan's `effects`, shown to the agent and the person |
| Two endpoints for two ways of doing one job | Two plans from one job |
| Ids like `cus_NffrFeUfNV2Hib` | Names or emails, resolved by your server |
| `4xx` errors | Errors that say how to fix the call, and `clarify()` for ambiguity |

## Five steps

### 1. Start from what users say, not from your endpoints

Write down the requests people make, then find the endpoints each one needs. Each request becomes one tool.

| What the user says | Stripe endpoints today | YEA |
|---|---|---|
| "What's going on with Chen's account?" | `GET` customers, subscriptions, charges | `customer {who}`, a read-only tool |
| "Refund Chen's last payment" | the three `GET`s, then `POST /v1/refunds` | `refund {who}`, a job |
| "Cancel Chen at the end of the month" | `POST /v1/subscriptions/:id` `cancel_at_period_end=true` | `cancel {who}`, plan 1 |
| "Cancel Chen right now" | `DELETE /v1/subscriptions/:id` | `cancel {who}`, plan 2 |
| "Actually, keep Chen's subscription" | `POST /v1/subscriptions/:id` `cancel_at_period_end=false` | `undo` the cancel. Nothing to build |

Five requests, eight endpoints, three tools, and the `undo` tool YEA adds. Endpoints agents shouldn't touch, like API keys or webhooks, are simply left out.

### 2. Turn reads into one plain tool

A read needs no approval, so it's an ordinary MCP tool. It makes the REST calls it needs and returns only what an agent needs to answer the question.

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
renews: 2026-10-12
payments[1]{id,date,amount,refunded}:
  ch_2,2026-09-12,49.00 USD,0.00 USD
```

</div>
</div>

- **Accept names and emails,** and resolve them in the server.
- **Return readable values:** dates, not timestamps; `49.00 USD`, not `4900`.
- **Keep rows flat,** so they render as a table.
- **Keep lists short:** the few rows an agent needs, not a page of everything.

::: details The code for this tool
<<< ../../examples/stripe-jobs.ts#read

<<< ../../examples/stripe-jobs.ts#read-tool
:::

### 3. Turn writes into jobs

A job returns one or more **plans**. You fill in a plan from what you already know about the REST call:

| Plan field | What goes in it | For a refund |
|---|---|---|
| `summary` | One line a person would read | `Refund 22.87 USD of ch_2 to Chen Wei` |
| `effects` | Everything the call changes, including emails | the charge, and the receipt email |
| `uses` | What it uses up, such as the money it moves | `spend 22.87 USD` |
| `apply()` | The REST call | `POST /v1/refunds` |
| `undoWindow` | How long it can be undone for, with the job's `revert()` | none, so `undo: never` |

::: code-group
<<< ../../examples/stripe-jobs.ts#refund-plan [TypeScript]
<!-- PYTHON TAB: parley-05 adds the Python equivalent here, as a second tab:
     <<< @/../python/mcp/examples/<file>.py#refund-plan [Python] -->
:::

The job ties the plans to a tool. `plan()` only reads: it runs on preview and on every retry, and `apply()` runs at most once, after the plan is approved or allowed.

<<< ../../examples/stripe-jobs.ts#refund-job

When a reverse call exists, the job's `revert()` makes it, and plans that set an `undoWindow` become undoable. Cancelling at the end of the month is undone by setting `cancel_at_period_end` back to `false`:

::: code-group
<<< ../../examples/stripe-jobs.ts#cancel-plan [TypeScript]
<!-- PYTHON TAB: parley-05 adds the Python equivalent here, as a second tab:
     <<< @/../python/mcp/examples/<file>.py#cancel-plan [Python] -->
:::

<<< ../../examples/stripe-jobs.ts#cancel-job

- **List every effect.** The person approves what the plan says, so `apply()` must do nothing more.
- **Add `revert()` only if it really restores the old state.** Only undoable plans can run without asking, under the person's signed policy. Everything else asks every time.
- **Offer the choices a person would,** like "full or unused days" and "now or at period end". Put the safest common choice first.

### 4. Make errors say how to fix the call

A plan that throws becomes an error result carrying its message, and nothing runs. Make the message say what to do next.

| When | With YEA | Include |
|---|---|---|
| Params are out of range | Throw an error | The fix: `refund at most 49.00 USD` |
| A name matches several records | Return `clarify()` | One option per match |
| `404` | Throw an error | Which tool would find it |
| `429` or `5xx` | Throw an error | When to retry |

### 5. Skip the plumbing

The approval form and its typed confirmation, consent codes for clients that can't ask, the signed policy, one-time approval, `preview` and `undo` come with `job()`. You don't build them. See [Add YEA to your MCP server](/guide/mcp-typescript).

## The full example

[`examples/stripe-jobs.ts`](../../examples/stripe-jobs.ts) puts these three tools in front of the real Stripe API. It handles two-decimal currencies only, and refuses the rest; the `@yea-protocol/stripe` connector handles every Stripe currency. `@yea-protocol/mcp` isn't on npm yet, so run it from a clone of the repo, after `npm ci && npm run build`, with a test-mode key:

```sh
claude mcp add billing -e STRIPE_SECRET_KEY=sk_test_… -- npx tsx examples/stripe-jobs.ts
```

::: details Show the full file
<<< ../../examples/stripe-jobs.ts
:::

## Checklist

- [ ] Each tool is something a user would ask for
- [ ] Names and emails work wherever ids do
- [ ] Each read answers a whole question in one call
- [ ] `apply()` makes the REST call; `revert()` reverses it, or doesn't exist
- [ ] Every plan lists all its effects and what it really uses
- [ ] Choices are separate plans, safest first
- [ ] Every error says how to fix the call

## Implementing the protocol: the same design as a service

YEA is also a protocol with its own verbs, for services that agents reach directly or through the `yea mcp` bridge. There, the same billing API is a `service()` whose reads are `ASK`s and whose writes are `INTENT`s that return proposals:

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

The agent commits a plan with `COMMIT`, under the human's grant or with their consent. The design steps above carry over; only the API differs. In a protocol service, `revert()` sits on the plan itself:

::: details The ASK
<<< ../../examples/stripe-billing.ts#ask
:::

<<< ../../examples/stripe-billing.ts#refund-plan

<<< ../../examples/stripe-billing.ts#cancel-plan

Errors are `YeaError`s with machine-applicable fixes, and ambiguity is a `CLARIFY` reply. See [Build a service](/guide/build-a-service) for the library API.

[`examples/stripe-billing.ts`](../../examples/stripe-billing.ts) runs it against the real Stripe API with a test-mode key:

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
