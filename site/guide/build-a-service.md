# Build a service

A YEA service is a set of capabilities plus the protocol machinery around them, which the library provides. You write what's specific to your domain: what can be read, and how an intent turns into concrete, undoable plans. For what makes those choices good, see [From REST to YEA](/guide/service-design).

## Capabilities

```ts
import { service, create, update, remove, send, charge, money, clarify, YeaError, fix } from "@yea-protocol/sdk";

const shop = service({
  id: "shop.example",          // the audience id: proofs are bound to it, so keep it stable
  name: "Example Meals",
  summary: "Chef-made meal delivery.",
  trust: [PRINCIPAL_KEY],      // principals whose grants you accept
  // requireGrants: true,      // also require grants for ASK and INTENT
  // proposalTtl: 600,         // seconds a proposal stays committable
});
```

**`ask`** is read-only by definition. Agents retry it freely, and it must not change anything the principal could observe.

```ts
shop.ask("shop.search", {
  summary: "Search the menu",
  params: { "query?": "string", "tag?": "high-protein|spicy|vegetarian|vegan", "max_cal?": "int" },
  run: ({ params }) => catalog.filter((m) => !params.tag || m.tags.includes(params.tag)),
});
```

**`intent`** returns one plan, several (alternatives), or `clarify(question, options)`. Nothing happens until the agent commits.

```ts
shop.intent("shop.order", {
  summary: "Order meals for delivery",
  params: { items: [{ sku: "string", qty: "int" }], deliver: "date" },
  risk: "low",
  plan: ({ params }) => ({
    summary: `4 meals for ${params.deliver} — 53.95 USD`,
    effects: [create("order/o1001", "2× Tofu Pad Thai, 2× Shawarma"), create("charge", "53.95 USD to card ••4242")],
    uses: { spend: spend("53.95", "USD") },  // what it uses up; grants can limit it
    undoWindow: 7200,
    data: { subtotal: 47.96, delivery: 5.99 }, // not hashed, may hold floats; must not describe effects
    apply: (ctx) => {                          // on COMMIT, at most once
      ctx.progress("authorizing card", 0.3);   // streamed to the agent as EVENTs
      return placeOrder();
    },
    revert: () => cancelOrder(),               // present, so the proposal is undoable
  }),
});
```

## The compact param schema

Parameter names map to type strings: `string`, `int`, `number`, `bool`, `date`, `datetime`, `any`, or an enum such as `low|medium|high`. Append `[]` for arrays and ` — description` for a note to the model. A trailing `?` makes a parameter optional. A nested object is a nested schema, and a one-element array of one is an array of objects. Params are validated automatically, with fixes such as renaming a near-miss key.

## Errors that teach

Throw `YeaError(code, message, { fix: [...] })`. A fix is a sentence plus an optional params patch that should make the request succeed:

```ts
throw new YeaError("conflict", `${to} overlaps "Design review"`, {
  fix: [fix("use free slot 2026-09-27T10:00:00Z", { to: "2026-09-27T10:00:00Z" })],
});
```

## Serve it

```ts
import { listen, serveHttp } from "@yea-protocol/sdk/node";
import { fetchHandler } from "@yea-protocol/sdk";

await listen(shop);                          // yea://127.0.0.1:7447 (pass tls options for yeas://)
await serveHttp(shop, { port: 8080 });       // POST /yea, GET /.well-known/yea
export default { fetch: fetchHandler(shop) } // Cloudflare Workers, Bun, Deno
```

## What the library does for you

Budgets and `EXPAND` handles, idempotent commits and replays, requester binding, grant and proof verification, reservations against `total` limits, consent requests, auto-commit, undo windows and Lens. See the [Python page](/guide/python) for the same in Python, and the [spec](/reference/spec) for the wire contract.
