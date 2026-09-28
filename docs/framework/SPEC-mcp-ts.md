# Spec: mcp-ts

`@yea-protocol/mcp`: the approval contract ([SPEC-approval.md](SPEC-approval.md)) as a plugin for
the official TypeScript MCP SDK v2 (`@modelcontextprotocol/server` 2.1). A server author adds
job tools, or turns an existing tool into one, and gets previews, typed approval, a signed
policy, consent codes and undo, on both protocol eras.

Issue: [#38](https://github.com/yea-protocol/yea/issues/38). Map: [README.md](README.md).
SDK facts below were checked against the shipped 2.1.0 types on 2026-09-28.

## Objective

```ts
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { yea } from '@yea-protocol/mcp';
import { quantity } from '@yea-protocol/sdk';
import * as z from 'zod';

const approvals = yea();                                   // policy, store, keys: see yea()
const server = new McpServer({ name: 'billing', version: '1.0.0' }, approvals.serverOptions());

approvals.job(server, 'refund', {
  description: 'Refund what is left of a charge',
  inputSchema: z.object({ charge: z.string() }),
  risk: 'low',
  plan: async ({ charge }) => {
    const ch = await stripe.charges.retrieve(charge);       // reads only: plan() never acts
    const cents = ch.amount - ch.amount_refunded;
    const shown = (cents / 100).toFixed(2);

    return [{
      summary: `Refund ${shown} USD of ${charge}`,
      effects: [{ op: 'create', target: 'refund', detail: `${shown} USD to ${ch.customer}` }],
      uses: { spend: quantity(cents, { scale: 2, unit: 'USD' }) },
      apply: () => stripe.refunds.create({ charge, amount: cents }),
    }];
  },
  confirmWith: (_hp, { charge }) => charge,                // the person types the charge id
});

serveStdio(() => server);
```

From the model's side, `refund` is an ordinary tool. A call either runs and returns a receipt,
or the person sees the plan in their client and types the phrase to approve it, or (when the
client can't ask) the call returns the plan and a consent code for `yea approve`. Adding
`"preview": true` to any job call returns the plans and does nothing.

**Users.** Authors of TypeScript MCP servers. They adopt YEA one tool at a time, without
changing their transport or their other tools.

## The API

### `yea(options?)`

Creates the approval context for one server. Everything has a default:

| Option | Default | Meaning |
|---|---|---|
| `store` | `FileStore` (stdio), `MemoryStore` (HTTP, see §5) | The `ApprovalStore` (SPEC-approval §8). |
| `serverKey` | read or created at `~/.yea/server/<name>.key` (0600) | The server's Ed25519 seed. Its public key is the service id and the holder of policy and consent grants. |
| `principal` | `readPinnedKey()`, from `YEA_PRINCIPAL_PUB` | The pinned principal public key. If it's missing or refused, nothing auto-runs and no consent is accepted; every job asks, or fails closed. |
| `policy` | `YEA_POLICY` (a `pg1.` token, or a path to one) | The signed policy grant. Re-read on every call, so a new grant applies without a restart. |
| `tighten` | `{}` merged with `~/.yea/policy.json` | The unsigned tightening (`deny`, `outOfBand`), read with `readTightening`. |
| `stateKey` | random per process | The ≥ 32-byte key for the request-state codec. Multi-process HTTP servers must pass a shared one. |
| `sub` | ``ctx => ctx.http?.authInfo?.clientId ?? ''`` | Who is calling, for the state binding and undo. |

`approvals.serverOptions()` returns `{ requestState: { verify } }` for `new McpServer`,
installing `createRequestStateCodec({ key: stateKey, ttlSeconds: 600, bind })` with
``bind = ctx => `${ctx.mcpReq.method}\0${sub(ctx)}` ``. Without it the SDK hands the handler
the raw, attacker-controlled `requestState`, so `job()` refuses to register on a server whose
options don't include it (it checks for the codec's `verify`).

### `approvals.job(server, name, config)`

Registers a job tool. `config`:

| Field | Meaning |
|---|---|
| `title`, `description`, `annotations` | As in `registerTool`. See §4 for the annotation defaults. |
| `inputSchema` | Any Standard Schema with JSON Schema (zod 4, ArkType, Valibot, or `fromJsonSchema`). The input must be an object with no non-integer numbers (SPEC-approval §1). |
| `risk` | The tool's default plan risk; a plan's own `risk` wins; else `medium`. |
| `plan(input, ctx)` | Returns `JobPlan[]`, a `clarify(...)` question, or throws. It **must not change anything**: it runs on preview, on every retry, and again under the legacy shim. |
| `revert({ input, planHash, result }, ctx)` | Optional. With it, plans that set `undoWindow` are undoable. |
| `confirmWith(plan, input)` | Optional. The phrase the person types for a plan; `approve` if absent or empty. |

`JobPlan` is the SDK core's: `summary`, `effects`, `uses?`, `risk?`, `undoWindow?`, `data?` and
`apply()`. `apply` runs at most once per approval and only after the plan is allowed.

### `approvals.guard(tool, config)`

Turns an existing registered tool into a job without rewriting it. `tool` is the
`RegisteredTool` that `registerTool` returned; `config` has `describe(input)`, which returns
`{ summary, effects, uses?, risk?, undoWindow? }`, plus the optional `revert` and
`confirmWith`. The tool's own callback becomes the plan's `apply`, and the guarded callback is
installed with `tool.update({ callback })`, the SDK's supported way to replace a handler. The
SDK has no tool-call middleware (typescript-sdk PR #2820 is still a draft), so this is the
only hook.

### The `undo` tool

Registered once, the first time a job with `revert` is added:
`undo({ receipt: string })`. It calls the core's `undoJob` with `sub(ctx)` and the job's
`revert`, and returns the undo receipt or the refusal (SPEC-approval §7). Its annotations say
`destructiveHint: true, idempotentHint: true`.

## How a call runs

The guarded callback does, in order (SPEC-approval §5 and §6):

1. **Preview.** If the input has `preview: true`, compute and hash the plans and return them as
   Lens text (`structuredContent: { plans }`). Nothing is stored.
2. **Validate.** Strip `preview`, validate the rest with the author's schema
   (`~standard.validate`), and refuse non-integer numbers.
3. **Plan.** Call `plan(input, ctx)` and `hashPlans`. A clarification is returned as text. No
   plans means an `isError` result.
4. **Retry?** If `ctx.mcpReq.requestState()` returns our state (`{ yea: … }`), go to step 9.
5. **Consents.** For each plan, in order, look up `store.getConsent(planHash)`. Check it with
   `checkJobConsent`, then `consumeOnce(<grant id>, exp)`. The first that passes runs that
   plan (step 10). A consumed or failing consent counts as absent.
6. **Decide.** `decide(plans, policy, used, now)`, where `used` reads the store and `now` is
   the call time.
   - `run`: `reserveAll`, which falls back to `ask` if a limit fills up meanwhile, then run
     (step 10).
   - `denied`: an `isError` result.
   - `out-of-band`: fail closed with consent codes (step 8).
   - `ask`: ask (step 7).
7. **Ask.** If the client can take a form elicitation (see below), `buildForm`. A null form
   (nothing offerable) fails closed (step 8). Otherwise return
   `inputRequired({ inputRequests: { yea: inputRequired.elicit({ message, requestedSchema }) },
   requestState: await codec.mint({ yea: newState(...) }, ctx) })`.
8. **Fail closed.** Return `isError: true` with the plans in Lens, a `jobConsentCode` for each
   offerable plan, and: *Ask the user to run `yea approve <code>` in their terminal, then call
   again.* (`structuredContent: { plans, codes }`).
9. **Answer.**
   - `checkState` against this tool, the input hash, `sub(ctx)` and now. Then
     `consumeOnce(state.nonce, state.exp)`. Any failure refuses, with one message.
   - Read the answer with `inputResponse(ctx.mcpReq.inputResponses, 'yea')` (`accept`,
     `decline` or `cancel`, and the content), then `judgeAnswer` against the recomputed plans.
   - `run`: step 10. `ask-again`: step 7 with the verdict's round. `out-of-band`: step 8 for
     that plan. `denied`, `refuse` and `not-approved`: a plain result saying so.
10. **Run.** Call `apply()`. On success, `settle` the reservations and `putReceipt` a
    `JobReceipt` (`newReceiptId`, `sub`, `input`, `planHash`, `result`, and `undo.until` if
    undoable). Return the receipt as Lens text, with `structuredContent: { receipt, result }`.
    On failure, `release` the reservations and return `isError` saying the approval was used
    and nothing changed (SPEC-approval §5 step 8).

**Can the client ask?** On a 2026-07-28 request, read the client capabilities from
`ctx.mcpReq.envelope['io.modelcontextprotocol/clientCapabilities']`. On a 2025-era connection,
read them from `server.server.getClientCapabilities()`. Either `elicitation.form` or a bare
`elicitation: {}` means yes. On legacy stateless HTTP (below), the answer is always no.

**The two eras.**
- **2026-07-28 clients:** the `inputRequired` result goes to the client, which calls the tool
  again with `inputResponses` and the sealed `requestState`.
- **2025-era clients:** the SDK's legacy shim (on by default) sends `elicitation/create`, then
  re-runs the whole callback with `inputResponses` filled in and the state passed in-process
  (still verified). Our callback can't tell the eras apart, and doesn't need to.
- **Legacy stateless HTTP:** the shim can't reach the client (`createMcpHandler`'s default
  `legacy: 'stateless'`), so those calls take step 8.

## Results and annotations

- **Results.** Text content is always Lens, for the model. `structuredContent` carries the same
  thing as data. Errors use `isError: true`, never a thrown JSON-RPC error, so the model sees
  the reason and the fix.
- **Annotations.** Defaults: `readOnlyHint: false` and `idempotentHint: false`.
  `destructiveHint` is `true`, since a job changes things, unless the author sets it.
  `openWorldHint` is the author's. Annotations are hints clients may ignore; enforcement is on
  the server.
- **Risk metadata.** Each job tool's `_meta['dev.yea/job']` is `{ risk, undoable }`, where
  `undoable` means the tool has `revert`. When SEP-2793 (Tool Risk Metadata) is accepted, the
  same data also goes in its fields. Until then we don't pre-empt its names.

## The two SDK-dependent seams

These rely on SDK behaviour we don't control, so each gets its own test and a note in the code:

- **`tool.update({ callback })`** for `guard`. If the SDK adds middleware (PR #2820), `guard`
  moves to it.
- **The capability lookups** above, including the deprecated `getClientCapabilities()` for the
  2025 era, and the envelope key (typed as `{}` in 2.1.0, so read through a narrow cast).

## Package

- `mcp/`: a new workspace, `@yea-protocol/mcp`.
- Dependencies: `@yea-protocol/sdk`. Peer dependency: `@modelcontextprotocol/server ^2.1`.
- No zod dependency: schemas are Standard Schema.
- Node ≥ 20 (the SDK's floor). ESM only.
- `yea mcp` (the 2025-era bridge) moves onto this package in `bridge` (#40), not here.

## Code layout

```
mcp/src/index.ts       yea(), job(), guard(), undo tool registration
mcp/src/call.ts        the guarded callback: steps 1–10
mcp/src/client.ts      can-the-client-ask, per era
mcp/src/keys.ts        server key, pinned principal, policy and tightening loading
mcp/src/render.ts      Lens text and structuredContent for plans, receipts and codes
mcp/test/*.test.ts     in-memory client tests (below)
```

## Testing

In-memory clients built with `@modelcontextprotocol/client` (a dev dependency), three kinds:
a 2026-07-28 client that elicits, a 2025-era client (through the shim), and one that can't
elicit. For each:

- a job the policy allows runs once, returns a receipt, and reserves and settles its totals;
- a job outside the policy asks; typing the phrase runs it; a wrong phrase asks again; the
  third wrong one refuses; decline and cancel run nothing;
- the same state sent twice runs nothing the second time;
- a client that can't ask gets consent codes; after `yea approve` (driven through
  `readJobConsent` and `signJobConsent`) the next call runs, once;
- `preview: true` runs nothing and stores nothing;
- `undo` works within the window and refuses after it, or for another `sub`;
- `guard` wraps an existing tool, and the original callback only runs once approved;
- a server without `serverOptions()` refuses to register a job;
- a tampered `requestState` is refused by the codec.

Security tests (in `mcp/test/security.test.ts`) repeat the approval core's list from the MCP
side: a denied tool never runs; a `high` plan never runs in the form; an irreversible plan never
auto-runs; a consent for one plan never runs another; and a stored copy of the policy grant
never counts as a consent.

## Boundaries

- **Always:**
  - put the decision in the approval core, not here;
  - read the policy and time on every call;
  - fail closed on anything unexpected: a missing codec, key, grant or store error.
- **Ask first:**
  - depend on anything beyond the SDK core and the MCP server SDK;
  - change the plaintext of `requestState`;
  - add tools other than `undo`.
- **Never:**
  - trust `requestState` without the codec;
  - run `apply()` from `plan()`;
  - treat an annotation as enforcement;
  - use sampling.

## Success criteria

- A server author can add one job tool to an existing server with the snippet above, and the
  three client kinds behave as in Testing.
- The same job behaves the same on stdio (`serveStdio`) and Streamable HTTP
  (`createMcpHandler`), except that legacy stateless HTTP fails closed.
- `guard` works on a tool registered by code the author didn't change.
- All approval decisions come from the SDK core, so `conformance/approval.json` covers them.

## Decisions

Adopted for v0 under the standing go-ahead; any can be reopened.

1. **`preview` is an input field, not a separate tool.** The plugin adds `preview?: boolean` to
   the tool's JSON Schema and strips it before the author's schema validates. That keeps one
   tool per job (the map's rule).
2. **The server key lives in `~/.yea/server/<name>.key`.** SPEC-approval §9 lists what must be
   out of the agent's reach, and the server key isn't one of them. A consent can't be forged
   with it (consents are single-block grants from the principal), and a policy can only be
   narrowed by it.
3. **The policy comes from `YEA_POLICY` or an option.** `yea grant --to <server key>` makes it;
   a `yea policy` helper that finds a server's key and installs the grant comes with the docs
   module (#42).
4. **No nested questions in v0.** A plan handler can return a clarification (text), not its
   own `inputRequired`. The `{ yea, inner }` nesting in SPEC-approval §4 comes later if an
   author needs it.
5. **HTTP servers default to `MemoryStore`**, and refuse to start with a `total` in the policy
   unless the author passes a shared store or sets `singleProcess: true` (SPEC-approval §8).
