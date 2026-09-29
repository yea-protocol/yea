# Spec: mcp-ts

`@yea-protocol/mcp`: the approval contract ([SPEC-approval.md](SPEC-approval.md)) as a plugin for
the official TypeScript MCP SDK v2 (`@modelcontextprotocol/server` 2.1). A server author adds
job tools, or turns an existing tool into one, and gets previews, typed approval, a signed
policy, consent codes and undo, on both protocol eras.

Issue: [#38](https://github.com/yea-protocol/yea/issues/38). Map: [README.md](README.md).
SDK facts below were checked against the shipped 2.1.0 types and sources on 2026-09-28.

## Objective

```ts
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { yea } from '@yea-protocol/mcp';
import { quantity } from '@yea-protocol/sdk';
import * as z from 'zod';

const approvals = yea({ name: 'billing', transport: 'stdio' }); // once per process

serveStdio(() => {                                              // the SDK may call this more than once
  const server = new McpServer({ name: 'billing', version: '1.0.0' }, approvals.serverOptions());

  approvals.job(server, 'refund', {
    description: 'Refund what is left of a charge',
    inputSchema: z.object({ charge: z.string() }),
    risk: 'low',
    plan: async ({ charge }) => {
      const ch = await stripe.charges.retrieve(charge);         // reads only: plan() never acts
      const cents = ch.amount - ch.amount_refunded;
      const shown = (cents / 100).toFixed(2);

      return [{
        summary: `Refund ${shown} USD of ${charge}`,
        effects: [{ op: 'create', target: 'refund', detail: `${shown} USD to ${ch.customer}` }],
        uses: { spend: quantity(cents, { scale: 2, unit: 'USD' }) },
        apply: () => stripe.refunds.create({ charge, amount: cents }),
      }];
    },
    confirmWith: (_hp, { charge }) => charge,                  // the person types the charge id
  });

  return server;
});
```

From the model's side, `refund` is an ordinary tool. A call either runs and returns a receipt,
or the person sees the plan in their client and types the phrase to approve it, or (when the
client can't ask) the call returns the plan and a consent code for `yea approve`. Adding
`"preview": true` to any job call returns the plans and does nothing.

**Users.** Authors of TypeScript MCP servers. They adopt YEA one tool at a time, without
changing their transport or their other tools.

## The API

### `yea(options)`

Creates the approval context, **once per process**. The SDK calls a server factory once per
request on HTTP (`createMcpHandler`) and sometimes more than once on stdio (`serveStdio` probes
`server/discover`), so the factory builds a fresh `McpServer` and calls `job()` each time,
while keys, store and codec live in the one `yea()` context.

| Option | Default | Meaning |
|---|---|---|
| `name` | required | The server's name, `[a-z0-9._-]{1,64}`. Names its key file and appears in consent codes. |
| `transport` | required | `'stdio'` or `'http'`. Picks the defaults below. |
| `store` | `FileStore` for stdio (`YEA_STORE`, else `$YEA_HOME/store`, else `~/.yea/store`, the store `yea approve` writes to), `MemoryStore` for HTTP | The `ApprovalStore` (SPEC-approval §8). |
| `singleProcess` | `false` | HTTP only: a promise that one process serves every request. HTTP on a `MemoryStore` must set it. |
| `serverKey` | `~/.yea/server/<name>.key` | The server's Ed25519 seed, created on first run, mode `0600`, in a `0700` directory: written to a temp file and linked into place (which fails if the key exists, like `O_EXCL`), so a concurrent reader never sees an empty key. It is opened with `O_NOFOLLOW` (and `O_NONBLOCK`, so a FIFO can't block the open) and checked on the open file: a symlink, anything but a regular file, a file over 64 KiB, a file another user owns, or one readable by others is refused, and so is a key directory another user owns or others can write. Where the platform has no owners or mode bits to check (Windows), the file is read with a warning on stderr. `yea service-id <name>` reads the key under the same rules. Its public key is the service id, and the holder of policy and consent grants. |
| `principal` | `readPinnedKey()` (`YEA_PRINCIPAL_PUB`) | The pinned principal public key (`ed25519:…`). Passed as an option, it's taken as the author's code gives it, without the file check. If it's missing or refused, nothing auto-runs and no consent is accepted, so every job asks or fails closed: the consent-code result then carries no codes and says why. |
| `policy` | `YEA_POLICY` | The signed policy grant: a value starting with `pg1.` is the token, anything else is a path to one. Re-read on every call, so a new grant applies without a restart. |
| `tighten` | `{}` | Unsigned tightening, merged with `~/.yea/policy.json` through `readTightening`: `deny` is the union of both, and `outOfBand` the lower (stricter) of the two. A `policy.json` that can't be read, isn't a JSON object, or has a bad `deny` or `outOfBand` refuses every job call and says why: its `deny` can't be known. Unknown fields only warn. |
| `codec` | created from `stateKey` | An existing `createRequestStateCodec` result, for a server that already uses one. |
| `stateKey` | random per process | The ≥ 32-byte codec key. A shared key only makes sense with a shared store (see below). |
| `sub` | stdio: `() => ''`; HTTP: required | Who is calling. Used for the state binding and for undo. |

**Start-up refusals.** `yea()` throws, so nothing is served, when:

- `transport: 'http'` has no `sub` function;
- a `stateKey` is passed with a `MemoryStore`, because several processes would each consume
  the same nonce once;
- HTTP runs on a `MemoryStore` without `singleProcess: true`;
- `name` is invalid;
- the key file is unsafe;
- both `codec` and `stateKey` are passed.

**Per-call refusals.** `sub` returning `''` on HTTP refuses the call. A `total` on a
`MemoryStore` needs every request in one process: stdio is one process (the totals last as long
as it does), and HTTP promises it with `singleProcess: true`, which the start-up refusal above
requires, so there is no per-call check.

**MemoryStore and consent codes.** `yea approve` writes consents to a `FileStore`, which a
`MemoryStore` never reads. So on a `MemoryStore` (HTTP's default) the consent-code result
carries no codes and says why, as it does without a pinned principal.

A store is recognised as a `MemoryStore` by its brand (`isMemoryStore`, reading
`yeaStore === 'memory'`), not `instanceof`, so a second copy of the SDK can't slip one past these
refusals.

**HTTP serves one person in v0.** There is one pinned principal. `sub` must return that
person's identity from the transport's authentication (for example a subject the
authorization server puts in `authInfo.extra`). An OAuth `clientId` names an app, not a
person, and doesn't qualify.

**Start-up line.** Once the options pass, `yea()` writes one line to stderr (stdout belongs to
the stdio transport): `yea: service id <id> (name <name>)`, with the server's public key. It's
the id `yea grant --to` needs, so the person doesn't have to read the key file
([SPEC-docs.md](SPEC-docs.md), step 5).

`approvals.serverOptions()` returns `{ requestState: { verify: codec.verify } }` for
`new McpServer`. `approvals.serviceId()` resolves to the server's public key, the service id
that `yea grant --to` issues policy grants to. `codec` is `createRequestStateCodec({ key, ttlSeconds: 600, bind })` with
``bind = ctx => `${ctx.mcpReq.method}\0${sub(ctx)}` ``. The SDK has one `requestState`
verifier per server, so a server whose other tools use `requestState` passes its own codec
with `yea({ codec })`, and our state lives under the `yea` key of the payload.

### `approvals.job(server, name, config)`

Registers a job tool. `config`:

| Field | Meaning |
|---|---|
| `title`, `description`, `annotations` | As in `registerTool`. Annotation defaults are under Results. |
| `inputSchema` | A Standard Schema that exposes JSON Schema (`~standard.jsonSchema`): zod ≥ 4.2, ArkType, Valibot, or `fromJsonSchema`. Its root must be a plain object without a `preview` field, or `job()` throws. Inputs may hold no non-integer numbers (SPEC-approval §1). |
| `risk` | The tool's default plan risk. A plan's own `risk` wins; the default is `medium`. |
| `plan(input, ctx)` | Returns `JobPlan[]`, a `clarify(...)` question, or throws. It **must not change anything**: it runs on preview, on every retry, and again under the legacy shim. |
| `revert({ input, planHash, result }, ctx)` | Optional. With it, plans that set `undoWindow` are undoable. |
| `confirmWith(plan, input)` | Optional. The phrase the person types; `approve` if it's absent or empty. It must be typeable: printable text with only plain spaces inside (SPEC-approval §3), or the call fails as a tool error. |

`JobPlan` is the SDK core's: `summary`, `effects`, `uses?`, `risk?`, `undoWindow?`, `data?`
and `apply()`. `apply` runs at most once per approval, and only after the plan is allowed.

**The input schema and `preview`.** The SDK validates `tools/call` arguments against the
registered schema before the callback runs, and passes on the parsed value, so a plain
`z.object` would silently drop `preview`. `job()` therefore registers a **wrapper** Standard
Schema:

- its JSON Schema is the author's, with `preview: { type: 'boolean' }` added to `properties`;
- its `validate` takes `preview` off (anything but a boolean is an issue), validates the rest
  with the author's schema, and returns `{ ...validated, [PREVIEW]: true }` under a symbol key
  that can't come from JSON.

The callback reads and removes that symbol. The SDK passes the validated value straight to
the callback, so the symbol survives, and canonical JSON ignores symbol keys. `job()` and
`guard` call the wrapper's `jsonSchema.input` once when registering, because the SDK only
converts it later, when it lists tools; a schema that can't convert fails registration.

### `approvals.guard(server, tool, config)`

Turns a tool that's already registered into a job, without rewriting it. `tool` is the
`RegisteredTool` that `registerTool` returned, and `server` the `McpServer` it's registered
on. `config` has `describe(input)`, which returns `{ summary, effects, uses?, risk?,
undoWindow? }`, plus the optional `risk` (the tool's default plan risk and its `_meta` risk, as
in `job()`), `revert` and `confirmWith`.

`guard` needs the server as well as the tool: a `RegisteredTool` doesn't carry its name, and
the name is what plans hash, `deny` lists and `can` caveats match. The server is also where the
2025-era capabilities and the `undo` tool live. The SDK keeps its registry private, so `guard`
finds the tool's name there through a narrow cast (an SDK seam), and throws if the tool isn't
registered on that server.

Like `job()`, `guard` throws for a tool whose input schema already has a `preview` property, or
whose root isn't a plain object: the wrapper schema would shadow the tool's own argument. It
throws when called, and the tool stays disabled. It also throws, before touching the tool, for
a tool that is already a job (guarded before, or registered by `job()`): the wrapper would wrap
itself. The name is read once, when guarding, so renaming a guarded tool isn't supported.

The SDK has no tool-call middleware (typescript-sdk PR #2820 is still a draft), so `guard`
replaces the handler:

1. note whether the tool was enabled, then `tool.disable()`, so the original handler can't
   run in between;
2. `tool.update({ callback, paramsSchema })` with the guarded callback and the wrapper schema
   (a tool registered without a schema keeps the `cb(ctx)` form, and gets no `preview`);
3. if it was enabled, `tool.enable()`, only once the update succeeded. If anything throws,
   the tool stays disabled.

The original callback becomes the plan's `apply`. Its result is returned unchanged, so an
`outputSchema` still holds. The receipt goes in `_meta['dev.yea/receipt']`. If the original
returns `isError: true` or an `input_required` result, that counts as a failure: reservations
are released, no receipt is written, and the result is returned as is. The check reads the value
the original callback returned, structurally (`isError === true`, or `resultType ===
'input_required'`), and assumes no class: handlers often return plain literals.

**A guarded tool with an `outputSchema`.** A client rejects any success result whose
`structuredContent` doesn't match the tool's `outputSchema`; `isError: true` results are
exempt, in both eras. So on such a tool every result the plugin itself produces is
`isError: true`: the preview, the consent-code result, refusals and not-approved results. Only
the original callback's own result is returned as a success.

### The `undo` tool

`undo({ receipt: string })` is registered once per server, the first time a job with `revert`
is added. If the server already has a tool named `undo` that isn't ours, `job()` or `guard()`
throws before registering anything. It calls the core's `undoJob` with this server's service id, `sub(ctx)` and the
job's `revert`:

- A receipt from another server sharing the store, or for a tool with no `revert` here, is
  "no such receipt".
- It returns the undo receipt, or the refusal (SPEC-approval §7).
- A `revert` that throws a `PartialApplyError` is reported as failing part-way, with its
  message, never as "nothing was undone".
- Its annotations say `destructiveHint: true, idempotentHint: true`.

### `@yea-protocol/mcp/http`: the Streamable HTTP front end

For a server that serves one person over HTTP (above), the package exports the front end the
Stripe connector's `--http` runs on. `./http` is fetch-level (it needs only `node:crypto`, which
Bun, Deno and Workers with `nodejs_compat` have); `./http/node` has the Node server.

- `httpGate({ token, loopback })`: the checks, in one place. On loopback, the `Host` header
  (DNS rebinding: 421 Misdirected Request, as the Python MCP SDK answers it; `createMcpHandler`
  doesn't check Host itself); then `Authorization: Bearer <token>`, compared in constant time
  (401). It returns the refusal, or undefined to let the request through.
- `httpApp(factory, { token, sub, loopback, clientId?, maxBody? })`: a fetch handler that runs
  `httpGate` on every request, then `createMcpHandler` with `authInfo`
  `{ clientId (default 'yea-http'), extra: { sub } }`. The MCP handler reads at most `maxBody`
  (its `maxRequestBodySize`), so both checks hold on Workers, Bun and Deno too.
- `subOf(ctx)`: the `sub` for `yea({ sub })`: the verified request's, else `''`, which refuses the
  call.
- `httpAuthFrom(env)`: `{ token, sub }` from `YEA_HTTP_TOKEN` (32 characters or more) and
  `YEA_SUB`; throws, naming what's missing.
- `MAX_BODY`: the default cap, 1 MiB, the same as a YEA frame.
- `serveHttp(app, { port, host, gate?, maxBody?, requestTimeout?, maxConnections? })` from
  `./http/node`: the app on Node, through the SDK's `serveFetch` (`@yea-protocol/sdk/node`).
  Pass `gate: httpGate(...)` with the app's token, so a request without it is refused before its
  body is read. Request headers reach the app, because Streamable HTTP needs them (Authorization,
  Accept, Content-Type, `MCP-Protocol-Version`, `Mcp-Session-Id`, `Mcp-Method`, `Mcp-Name`,
  `Mcp-Param-*`, `Last-Event-ID`; the `Host` check reads Host). They arrive as the client sent
  them, `X-Forwarded-*` included and unfiltered. The URL is parsed against `http://localhost`,
  never the Host header.

**What `serveFetch` does with each request.**

1. The gate runs on the method, URL and headers, before any of the body is read. For
   `Expect: 100-continue` it runs before `100 Continue` is sent: a refused client never gets the
   go-ahead (and a declared body over the cap gets 413 instead).
2. The body is read, keeping at most `maxBody` bytes. A body declared over it (Content-Length)
   or streamed past it is answered 413, and the app never runs; reading pauses at the cap, so
   the drain below is an exact bound.
3. A refusal (the gate's, a 413, a 400 for a request fetch can't take) is framed by
   Content-Length with `connection: close`. The server then reads and discards up to 1 MiB more
   of the body, so a client that's nearly done sending reads the answer rather than a reset. Past
   that it stops reading and closes the connection a second later, time for the client to read
   the answer.
4. The app's response is piped with backpressure; if the client goes away, the request's signal
   aborts and the response body is cancelled.

A client has `requestTimeout` (default 30 s) to send its whole request, and `maxConnections`
(default: no limit) bounds how many are served at once. Memory: a request in flight holds at
most `maxBody`, about twice that while its chunks are joined; without the token, nothing. So the
worst case is about `2 × maxBody × maxConnections`.

`createMcpHandler` has a cap of its own (`maxRequestBodySize`, 4 MiB by default; it refuses a
declared Content-Length over it and stops reading once past it), which `httpApp` sets to
`maxBody`. Before this front end, the connector streamed the body into the MCP handler with no
cap of its own, relying on that 4 MiB default.

## How a call runs

The guarded callback does, in order (SPEC-approval §5 and §6):

1. **Validate.** The wrapper schema has already validated the input and taken `preview` off.
   Refuse non-integer numbers.
2. **Deny.** If the tool is in `deny`, return `isError` now, before `plan()` runs, before
   consents are read, and before a preview (a denied tool shows nothing).
3. **Plan.** Call `plan(input, ctx)`, then `hashPlans`. A clarification is returned as text.
   No plans means an `isError` result.
4. **Preview.** If `preview` was set, return the plans as Lens text
   (`structuredContent: { plans }`). Nothing is stored.
5. **Retry?** Read `ctx.mcpReq.requestState()`:
   - `undefined`: carry on;
   - an object with our `yea` key: step 10;
   - anything else refuses the call. A string means the codec isn't installed; an object
     without `yea` is another tool's state (possible with `yea({ codec })`).
6. **Consents.** For each plan, in order:
   - look up `store.getConsent(planHash)`, and check it with `checkJobConsent`;
   - `consumeOnce(<grant id>, <the consent grant's exp caveat>)`;
   - the first that passes runs that plan (step 11).

   A consent that is consumed, expired or failing counts as absent.
7. **Decide.** `decide(plans, policy, used, now)`, with `used` reading the store and `now` the
   call time in seconds.
   - `run`: `reserveAll`, then step 11. If `reserveAll` returns null, ask (step 8), with why
     "a limit filled up while this call was being decided".
   - `denied`: an `isError` result.
   - `ask` or `out-of-band`: step 8. The form leaves out-of-band plans unoffered.
8. **Ask.** If the client can take a form (below), `buildForm`; if it can't, or the form is
   null, step 9. Otherwise return:
   ```ts
   inputRequired({
     inputRequests: { yea: inputRequired.elicit({ message, requestedSchema }) },
     requestState: await codec.mint({ yea: newState({ …, plans: form.offered, round }) }, ctx),
   })
   ```
   `round` is 1 on a first ask, and the verdict's round on an ask-again.
9. **Fail closed.** Return `isError: true` with the plans in Lens, a `jobConsentCode` for each
   plan that isn't denied, and: *Ask the user to run `yea approve <code>` in their terminal,
   then call again.* The result carries `structuredContent: { plans, codes }`. Without a pinned
   principal key, or on a `MemoryStore`, no consent can be accepted, so there are no codes, and
   the result says why.
10. **Answer.**
    - `checkState(state.yea, { tool, inputHash, sub, now })`, then
      `consumeOnce(state.yea.nonce, state.yea.exp)`. Any failure refuses, with one message.
    - Read the answer with `inputResponse(ctx.mcpReq.inputResponses, 'yea')`. `missing` counts
      as not approved.
    - Use the plans step 3 computed on this call (recomputed, since the handler re-ran), then
      `judgeAnswer`:
      - `run`: step 11;
      - `ask-again`: step 8 with the verdict's round;
      - `out-of-band`: step 9 for that plan;
      - `denied`, `refuse`, `not-approved`: a plain result saying so.
11. **Run.** Call `apply()`.
    - **If it throws** (for `guard`: or returns an error or `input_required`): `release` the
      reservations and say the approval was used and nothing changed (SPEC-approval §5
      step 8).
    - **If it throws a `PartialApplyError`** (any error with `partial: true`, checked
      structurally): it failed after changing something, such as a connector's second write
      failing and its clean-up failing too. The result shows its message, which says what was
      left behind, and never "nothing changed". The reservations stay held, which can only
      over-count.
    - **If it succeeds:** first make the result JSON-safe (a JSON round trip; one that fails,
      such as a circular or `bigint` result, becomes `null` with a note, so the response can
      always be sent). Then `settle`, then `putReceipt` a `JobReceipt`:
      - `id = newReceiptId()`, `service` = this server's service id;
      - `proposal = planHash`, `capability = tool`, `summary`, `at = now`, `effects`, `uses`;
      - `undo = { until: now + undoWindow }` when undoable, else `null`;
      - `tool`, `input`, `planHash`, `sub` and `result`.

      Return the receipt as Lens text with `structuredContent: { receipt, result }`, or for
      `guard`, the original result with the receipt in `_meta`.
    - **Anything after `apply()` succeeded** runs in its own `try`: a failure there (`settle`,
      `putReceipt`, a result that couldn't be serialized) never says "nothing was run". It
      says the action happened, and whether undo is available (the receipt was saved, and the
      plan is undoable) or not. For `guard`, the original's result, when it's usable (not a
      failure and serializable), is kept with that line appended (as `mcp-py`).

**Can the client ask?** This follows the SDK's own check (`_inputRequestCapabilityView`), so
we never return an `inputRequired` the SDK would then refuse with a `-32021` error or a shim
failure. The era is the server instance's negotiated revision
(`server.server.getNegotiatedProtocolVersion()`, deprecated but what the SDK branches on), not
whether the request carries an envelope, which a 2025 client can spoof:
- On the 2026-07-28 era, use only the envelope's
  `['io.modelcontextprotocol/clientCapabilities']`, read through a narrow cast because 2.1.0
  types the envelope as `{}`. A missing key means no.
- On the 2025 era, use `server.server.getClientCapabilities()`, the capabilities from
  `initialize`, whatever the request's envelope claims. It's deprecated, but it's the SDK's own
  source for that era.
- `elicitation.form`, or a bare `elicitation: {}`, means yes.
- No capabilities at all (a legacy stateless HTTP request, which never saw `initialize`)
  means no.

**The two eras.**
- **2026-07-28 clients:** the `inputRequired` result goes to the client, which calls the tool
  again with `inputResponses` and the sealed `requestState`.
- **2025-era clients:** the SDK's legacy shim (on by default) sends `elicitation/create`, then
  re-runs the whole callback with `inputResponses` filled in and the state passed in-process
  (still through `verify`). Steps 1–8 have no side effects, and step 10 consumes the nonce, so
  the re-run can't double-apply. `MAX_ROUNDS` (3) is below the shim's `maxRounds` (8).
- **Legacy stateless HTTP:** the shim can't reach the client (`createMcpHandler`'s default
  `legacy: 'stateless'`), so those calls take step 9.

## Results and annotations

- **Results.**
  - Text content is always Lens, for the model, and `structuredContent` carries the same as
    data.
  - Service text in the Lens is untrusted and escaped with `printable`, so it can't forge a
    line or hide characters: plan summaries and effect lines (as in the approval form,
    SPEC-approval §3), the reason in a consent result, a clarification's question and labels,
    error messages from `plan`, `apply` and `revert`, and a receipt, which is rendered with
    `untrustedLens`. `structuredContent` is data, not display, and keeps the raw strings.
  - Refusals and failures are `isError: true` results, so the model sees the reason and the
    fix.
  - On a guarded tool with an `outputSchema`, the plugin's own results (the preview too) are
    `isError: true`, because clients validate success results against that schema (see
    `guard`).
  - The one exception is a `requestState` the codec rejects: the SDK answers that with a
    JSON-RPC `-32602` error before our callback runs.
  - The package exports the helpers it builds these with, `textResult(lines, structured?)` and
    `errorResult(lines, structured?)`, so a server's own read tools answer in the same shape.
- **Annotations.**
  - Defaults: `readOnlyHint: false`, `idempotentHint: false`.
  - `destructiveHint` is `true` unless the author sets it, since a job changes things.
  - `openWorldHint` is the author's.
  - Annotations are hints clients may ignore; enforcement happens on the server.
- **Risk metadata.** Each job tool's `_meta['dev.yea/job']` is `{ risk, undoable }`, where
  `undoable` means the tool has `revert`. When SEP-2793 (Tool Risk Metadata) is accepted, the
  same data also goes in its fields. Until then we don't pre-empt its names.

## The SDK-dependent seams

These rely on SDK behaviour we don't control, so each gets its own test and a note in the code:

- `RegisteredTool.disable`/`update`/`enable` for `guard`. If the SDK adds middleware (PR
  #2820), `guard` moves to it.
- The private tool registry `guard` reads a tool's name from.
- The wrapper Standard Schema's `validate` and `jsonSchema.input`.
- The capability lookups, including the envelope key's cast.
- The legacy shim re-running the callback.

## Package

- `mcp/` is a new workspace, `@yea-protocol/mcp`.
- `@yea-protocol/sdk` and `@modelcontextprotocol/server ^2.1` are peer dependencies (and dev
  dependencies in the workspace), so a server has one copy of each.
- It is packed and published with the SDK and the CLI, after the SDK (`release.yml`).
- There's no zod dependency: schemas are Standard Schema.
- From the SDK core it uses the approval exports, plus small ones added for it:
  `assertIntegers` (step 1's check, before planning), `home` from `@yea-protocol/sdk/node`
  (where `~/.yea` is, honouring `YEA_HOME`), and `isMemoryStore` with `MemoryStore`'s brand.
- Node ≥ 20 (the SDK's floor), ESM only.
- `yea mcp` (the 2025-era bridge) moves onto this package in `bridge` (#40), not here.
- Four entry points: `.` (the job tools), `./bridge` (`yea mcp`), `./http` (the Streamable HTTP
  front end, fetch-level) and `./http/node` (its Node server, on the SDK's `serveFetch`).

## Code layout

```
mcp/src/index.ts           yea(), job(), and the public exports
mcp/src/guard.ts           guard(): wrapping a registered tool
mcp/src/undo.ts            the undo tool
mcp/src/call.ts            the guarded callback: steps 1–11, in order
mcp/src/call/context.ts    the approval context, the job as run, and step 1: caller, policy, phrase
mcp/src/call/approve.ts    steps 6–10: consents, the form and its rounds, consent codes
mcp/src/call/apply.ts      step 11: apply once, settle, and record the receipt
mcp/src/schema.ts          the wrapper Standard Schema that carries `preview`
mcp/src/client.ts          can the client ask, per era
mcp/src/server-key.ts      the server's name and key
mcp/src/policy.ts          pinned principal, policy and tightening loading
mcp/src/render.ts          Lens text and structuredContent for plans, receipts and codes
mcp/src/result.ts          tool results, refusals and annotations, shared with the bridge; job risk metadata
mcp/src/http.ts            the Streamable HTTP front end: token, Host check, body cap (`./http`)
mcp/src/http-node.ts       its Node server, on the SDK's serveFetch (`./http/node`)
mcp/src/util.ts            small internal helpers (isObject, errorMessage, warnOnce, errno, registryOf)
mcp/test/*.test.ts         in-memory client tests; security cases in mcp/test/security.test.ts
```

## Testing

In-memory clients built with `@modelcontextprotocol/client` (a dev dependency), of three
kinds: a 2026-07-28 client that elicits, a 2025-era client (through the shim), and one that
can't elicit. For each:

- a job the policy allows runs once, returns a receipt, and reserves and settles its totals;
- a job outside the policy asks. Typing the phrase runs it; a wrong phrase asks again, and
  the third wrong one refuses. Decline, cancel and a missing answer run nothing;
- the same state sent twice runs nothing the second time;
- a client that can't ask gets consent codes. After `yea approve` (driven through
  `readJobConsent` and `signJobConsent`), the next call runs, once;
- `preview: true` runs nothing and stores nothing, and a denied tool doesn't even preview;
- `undo` works within the window, and refuses after it, for another `sub`, and for a receipt
  from another server sharing the store;
- `guard` wraps an existing tool. The original callback runs only once approved, its result
  and `outputSchema` pass through, and a failed update leaves the tool disabled;
- the start-up and per-call refusals listed under `yea()`, and no codes on a `MemoryStore`;
- the start-up line, once, on stderr;
- after `apply()`: a result that can't be serialized applies once and says so, and a store
  failure says the action happened (for `guard`, appended to the original's result);
- a 2025 client that can't elicit, spoofing an envelope that says it can, gets consent codes;
- a legacy stateless HTTP request takes the consent-code path;
- the objective's shape: `serveStdio` (over an in-memory transport) with one `yea()` context,
  on both eras.
- the HTTP front end (`mcp/test/http.test.ts`): no token, a wrong one or another scheme gets
  401 and a foreign Host on loopback 421, before MCP; a call with the token runs as `sub`; a body
  over the cap, declared or streamed, even past what's drained, gets a readable 413 and the app
  never runs; a request without the token is refused before its body is read (declared under the cap,
  so the test fails if the body is read first), and never gets `100 Continue`; a slow request is
  cut off. The core's regression tests are in `ts/test/security.test.ts` (H4, H5).

Security cases in `mcp/test/security.test.ts`, the approval core's list from the MCP side.
Any fix that lands in the SDK core also gets its regression test in `ts/test/security.test.ts`
(repo rule 3):

- a denied tool never runs, even with a stored consent;
- a `high` plan is never offered in the form;
- an irreversible plan never auto-runs;
- a consent for one plan never runs another;
- a stored copy of the policy grant never counts as a consent;
- a `requestState` the codec didn't verify is refused;
- a verified state without our `yea` key, a state from another job on the same server, and an
  HTTP state replayed by another `sub` (through the codec's bind, and through `checkState` when
  an author's codec doesn't bind `sub`) run nothing.

## Boundaries

- **Always:**
  - put the decision in the approval core, not here;
  - read the policy and the time on every call;
  - fail closed on anything unexpected: a missing codec, key, grant or `sub`, or a store
    error.
- **Ask first:**
  - depend on anything beyond the SDK core and the MCP server SDK;
  - change the plaintext of `requestState`;
  - add tools other than `undo`.
- **Never:**
  - trust `requestState` that the codec didn't verify;
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

1. **`preview` is an input field, not a separate tool.** It rides on the wrapper schema, which
   keeps one tool per job (the map's rule).
2. **The server key lives in `~/.yea/server/<name>.key`.** SPEC-approval §9 lists what must be
   out of the agent's reach, and the server key isn't one of them. A consent can't be forged
   with it (consents are single-block grants from the principal), a policy can only be
   narrowed by it, and swapping it only changes the service id, which fails closed.
3. **The policy comes from `YEA_POLICY` or an option.** `yea grant --to <server key>` makes it.
   A `yea policy` helper that finds a server's key and installs the grant comes with the docs
   module (#42).
4. **No nested questions in v0.** A plan handler can return a clarification (text), not its
   own `inputRequired`. The `{ yea, inner }` nesting in SPEC-approval §4 comes later if an
   author needs it.
5. **HTTP serves one person, from one process by default.** HTTP needs an explicit `sub`, and
   a `MemoryStore` needs `singleProcess: true`. Multi-process servers pass a shared store and
   a shared `stateKey` together.
