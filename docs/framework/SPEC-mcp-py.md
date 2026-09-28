# Spec: mcp-py

`yea-mcp`: the approval contract ([SPEC-approval.md](SPEC-approval.md)) as a plugin for the
official Python MCP SDK (`mcp` 2.x, `MCPServer`), with an adapter for FastMCP 4. A server author
adds job tools, or turns an existing tool into one, and gets previews, typed approval, a signed
policy, consent codes and undo, on both protocol eras. It behaves like `mcp-ts`
([SPEC-mcp-ts.md](SPEC-mcp-ts.md)); where the SDKs differ, this spec says how.

Issue: [#39](https://github.com/yea-protocol/yea/issues/39). Map: [README.md](README.md).
SDK facts below were checked against `mcp` 2.2.0 and `fastmcp` 4.0.10 on 2026-09-28, with
in-memory clients of both eras.

## Objective

```python
from mcp.server.mcpserver import MCPServer
from yea import Plan, create, quantity
from yea_mcp import yea

approvals = yea(name="billing", transport="stdio")          # once per process

server = MCPServer("billing", request_state_security=approvals.request_state_security())

@approvals.job(server, risk="low", confirm_with=lambda hp, input: input["charge"])
async def refund(charge: str) -> list[Plan]:
    """Refund what is left of a charge."""
    ch = await stripe.charges.retrieve(charge)                # reads only: the plan never acts
    cents = ch.amount - ch.amount_refunded
    shown = f"{cents / 100:.2f}"
    return [Plan(
        f"Refund {shown} USD of {charge}",
        [create("refund", f"{shown} USD to {ch.customer}")],
        apply=lambda: stripe.refunds.create(charge=charge, amount=cents),
        uses={"spend": quantity(cents, scale=2, unit="USD")},
    )]

server.run("stdio")
```

From the model's side, `refund` is an ordinary tool, with the same three outcomes as in
`mcp-ts`: it runs and returns a receipt; or the person sees the plan in their client and types
the phrase; or (when the client can't ask) the call returns the plan and a consent code for
`yea approve`. Adding `"preview": true` to any job call returns the plans and does nothing.

**Users.** Authors of Python MCP servers on the official SDK or on FastMCP. They adopt YEA one
tool at a time, without changing their transport or their other tools.

## The API

### `yea(**options)`

Creates the approval context, **once per process**. It holds the server key, the store and the
request-state key. One `MCPServer` per process is the norm in Python, but the context doesn't
assume it.

| Option | Default | Meaning |
|---|---|---|
| `name` | required | The server's name, `[a-z0-9._-]{1,64}`. Names its key file, and is the request-state audience. |
| `transport` | required | `"stdio"` or `"http"`. Picks the defaults below. |
| `store` | `FileStore()` for stdio (`YEA_STORE`, else `$YEA_HOME/store`, else `~/.yea/store`), `MemoryStore()` for HTTP | The `ApprovalStore` (SPEC-approval §8). |
| `single_process` | `False` | A promise that one process serves every request. HTTP on a `MemoryStore` must set it. |
| `server_key` | `~/.yea/server/<name>.key` | The server's Ed25519 seed, the same one-line file as `mcp-ts`: created on first run through a temp file and a link (so a reader never sees it half-written), mode `0600`. Its directory must be this user's and writable by no one else (it's created `0700`), and that directory's parent this user's or root's and not writable by others unless sticky; without POSIX owners (Windows), as in `mcp-ts`, only the file checks apply. It's read with `O_NOFOLLOW` and checked on the open file (a regular file of at most 64 KiB, this user's, readable by no one else); without POSIX owners it warns once on stderr that it can't check who owns or can read the file, as `mcp-ts` does. Its public key is the service id, and the holder of policy and consent grants. |
| `principal` | `load_principal_key(YEA_PRINCIPAL_PUB)` | The pinned principal public key. If it's missing or refused, nothing auto-runs and no consent is accepted, so every job asks or fails closed. |
| `policy` | `YEA_POLICY` | The signed policy grant: a value starting with `pg1.` is the token, anything else is a path to one. Re-read on every call. |
| `tighten` | `{}` | Unsigned tightening, merged with `~/.yea/policy.json` through `read_tightening`: `deny` is the union, `outOfBand` the stricter. |
| `state_key` | random per process | The ≥ 32-byte request-state key (see below). |
| `sub` | stdio: `lambda rctx: ""`; HTTP: required | Who is calling. On `MCPServer` it gets the `ServerRequestContext` (a job passes `ctx.request_context`; the guard middleware has it directly); on FastMCP, FastMCP's request context. Used for the state binding and for undo. |

`approvals.service_id()` returns the server key's public key, the value to pass to
`yea grant --to` when issuing the policy.

**Start-up refusals.** `yea()` raises, so nothing is served, when `transport="http"` has no
`sub`; a `state_key` is passed with a `MemoryStore`; HTTP runs on a `MemoryStore` without
`single_process=True`; `name` is invalid; or the key file is unsafe.

**Per-call refusals.** `sub` returning `""` on HTTP refuses the call. On stdio with a
`MemoryStore` passed explicitly and without `single_process`, a policy with a `total` refuses
the call (the policy is read on every call, so this can't be checked at start-up). On HTTP the
start-up refusal already covers it.

**HTTP serves one person in v0**, as in `mcp-ts`. `sub` must return that person's identity from
the transport's authentication. The SDK's `authenticated_principal(ctx)` is **not** enough on
its own: without a subject it returns `'["<client>",null,null]'`, a non-empty string that names
an app, not a person. `yea_mcp.token_subject(ctx)` returns the verified token's `subject`, or
`""` when there is none, and is the recommended `sub`.

**No HTTP front end in `yea-mcp` (v0).** `mcp-ts` ships one (`@yea-protocol/mcp/http`: `httpGate`,
`httpApp`, `subOf`, `httpAuthFrom`; `serveHttp` from `/http/node`), with a bearer token compared in
constant time, a `Host` check on loopback against DNS rebinding (403), and a 1 MiB body cap. `yea-mcp`
has no counterpart; serve HTTP with the MCP SDK's own Streamable HTTP app (`streamable_http_app` or
`run_streamable_http_async`) and put `token_subject` in `sub`:
- On a loopback `host` the SDK checks `Host` and `Origin` itself (421 and 403). Off loopback, pass
  `transport_security=TransportSecuritySettings(allowed_hosts=[...])`, or put the server behind a
  proxy that checks `Host`.
- Pass `max_request_body_size=1 << 20` to match `mcp-ts`'s cap; the SDK's default is 4 MiB.
- Authenticate with the SDK's `TokenVerifier` or OAuth; a verifier for one static token compares it
  with `hmac.compare_digest`.

Porting the front end is tracked in [#176](https://github.com/yea-protocol/yea/issues/176).

### Request state: the SDK seals it

Unlike the TypeScript SDK, `MCPServer` seals every tool's `request_state` itself: its
`RequestStateBoundary` middleware encrypts it with AES-256-GCM and binds it to the method, the
tool name, a digest of the arguments, the authenticated principal and the audience (the server
name), with a 600-second lifetime. Code inside the boundary (tools and later middleware) reads
the plaintext; a tampered, expired or rebound token never reaches it, because the SDK answers
with an error first. It does **not** stop replay: the same token sent twice runs the handler
twice, which is why the core's `consume_once` on the state nonce stays.

`approvals.request_state_security()` returns `RequestStateSecurity(keys=[state_key], ttl=600,
audience=name)` for `MCPServer(request_state_security=...)` (FastMCP takes the same argument).
Without it the SDK uses a random per-process key, which is fine for stdio but breaks
multi-process HTTP. There is one boundary per server, so a server whose other tools use
`request_state` shares it. Our state is the JSON object `{"yea": {…}}`, and anything else
refuses the call.

### `@approvals.job(server, **config)`

Registers the decorated function as a job tool. The function is the **plan** function: its
parameters are the tool's input (as for `@server.tool()`), and it returns `list[Plan]`, a
`clarify(...)` question, or raises. It **must not change anything**: it runs on preview, on
every retry, and again on each round. It may declare a `Context` parameter: the wrapper reuses
it (rather than adding a second one) and leaves it out of `input`.

| Field | Meaning |
|---|---|
| `name`, `title`, `description`, `annotations` | As in `server.add_tool`. `description` defaults to the docstring. |
| `risk` | The tool's default plan risk. A plan's own `risk` wins; the default is `medium`. |
| `revert` | Optional `revert({"input", "planHash", "result"}, ctx) -> Any` (sync or async), as in `mcp-ts`. With it, plans that set `undo_window` are undoable. |
| `confirm_with` | Optional `confirm_with(plan: HashedPlan, input: dict) -> str`. The phrase the person types; `approve` if it's absent or empty. It must be typeable: printable text with only plain spaces inside (SPEC-approval §3), or the call fails as a tool error. |

`Plan` is the SDK core's (`summary`, `effects`, `apply`, `uses`, `risk`, `undo_window`,
`data`). For a job, `apply` takes no arguments and may be async; it runs at most once per
approval, and only after the plan is allowed.

**How `preview` gets in.** `MCPServer` builds a tool's input schema and argument model from the
function signature, and validates arguments before calling it. `job()` registers a wrapper
whose `__signature__` is the plan function's parameters plus `preview: bool = False` and a
keyword-only `ctx: Context`, with matching `__annotations__` (the SDK finds the context
parameter through `typing.get_type_hints`, so both are needed) and the return annotation
`CallToolResult`. The listed schema then shows `preview`, the SDK validates the rest, and the
wrapper takes `preview` off before calling the plan function. A plan function with its own
`preview` parameter, or with `*args`/`**kwargs`, fails registration. On FastMCP a job tool is
built with background tasks off (FastMCP's default), so it never runs as a task. A job with
`revert` on a server that already has a tool named `undo` (not YEA's) fails registration, as in
`mcp-ts`.

**What `input` is.** The SDK hands the wrapper validated Python objects (a pydantic model, a
`date`, an enum). The approval core needs JSON, for the plan hash, the consent code, the
receipt and `revert`. So `input` is each validated argument dumped in JSON mode, with the
argument's own type (`TypeAdapter(annotation).dump_python(value, mode="json", by_alias=True)`),
keyed by the parameter's name, so `revert` sees the wire shape. Canonical JSON takes integral
floats (`5.0` hashes as `5`) but refuses non-integral ones, so a call with `5.5` fails closed
with the core's "use a string or an integer" message (SPEC-approval §1).

### `approvals.guard(server, name, **config)`

Turns a tool that's already registered into a job without rewriting it. `config` has
`describe(input)`, which returns `{summary, effects, uses?, risk?, undo_window?}`, plus the
optional `revert`, `confirm_with` and `risk` (the default plan risk, and the risk its listing
shows, as `mcp-ts`'s `GuardConfig.risk`).

`guard()` refuses a tool that's already guarded on that server, and one registered with `job()`
(already a job): at once when this `yea()` registered it, else by the listing's
`_meta['dev.yea/job']`, which refuses its calls. Like `job()`, a guard with `revert` refuses,
before registering anything, a server whose own `undo` tool isn't this `yea()`'s (a tool of a
mounted server isn't seen). It installs the plugin's
middleware on **that** server, once (`server.middleware` is a
public list the SDK lets you extend after construction). So a guard can't be forgotten or
attached to the wrong server: the middleware only acts on `server`, and only for tools guarded
on it.

- It runs inside the request-state boundary (the SDK puts its own middleware first), so it sees
  plaintext `params["requestState"]` and the raw `params["inputResponses"]`. It runs before
  params are validated: a non-object `arguments`, or a `preview` that isn't a JSON boolean, is an
  `is_error` result, and the answer is checked with `ElicitResult.model_validate`.
- It takes `preview` off the arguments (`call_next(replace(ctx, params=...))`), so the original
  tool never sees it.
- On `tools/list` it adds `preview` to each guarded tool's listed schema, on a copy of the
  result.
- **What it learns from the listing.** On every guarded call it reads the server's public
  `await server.list_tools()` (in memory), so a tool re-registered since is judged by what's
  there now: a guarded tool whose own schema has a `preview` property is refused (the call fails
  closed), a tool whose `_meta` marks it a job is refused, and a tool with an `outputSchema` gets
  decision 6's error results.
- `describe` gets the raw arguments with `preview` taken off, before the tool validates them,
  and must treat them as untrusted. The plan hash binds that raw input, so what the person
  approves is exactly what the tool then receives (the SDK may coerce `"2"` to `2`, which
  doesn't change what was approved, but a `describe` that doesn't coerce the same way can show
  a misleading summary). Validating through the tool's own argument model would fix that, but
  it's a private SDK API (ask first).
- The original handler runs through `call_next`, which returns the **wire mapping** for
  `tools/call`, not a `CallToolResult` (`{"content", "isError", "structuredContent", "_meta",
  …}`, plus `"resultType"` on 2026). That is the plan's `apply`. A result with `isError: true`,
  or one that `mcp_types.methods.is_input_required` recognises, counts as a failure:
  reservations are released and no receipt is written. Otherwise its result is returned
  unchanged, as a copy with the receipt added under `_meta["dev.yea/receipt"]`.
- **Tools that ask their own questions** are not supported under `guard` in v0. On 2026 a
  tool's own `InputRequiredResult` (its resolvers run before its body) counts as a failure at
  run time, since its state would have no `yea` key and "nothing changed" can't be promised once
  it ran. On 2025 a `Resolve` asks in the call after our approval and completes, which is
  acceptable. There's no public way to see resolver parameters at `guard()` time, so there's no
  registration check.

`server.middleware` is marked provisional in `mcp` 2.x, so it is a seam (below). The SDK's
`Extension.intercept_tool_call` was the alternative, but extensions are fixed when the server is
built, so `guard()` couldn't check that its interceptor was installed on that server, and a
missing one would let the original run unguarded.

### The `undo` tool

`undo(receipt: str)` is registered once per server, the first time a job or guard with
`revert` is added. It calls the core's `undo_receipt(store, id, service, sub, now, revert)`
with this server's service id, `sub(ctx)` and the job's `revert`. A receipt from another server
sharing the store, or for a tool with no `revert` here, is "no such receipt". A `revert` that
raises a `PartialApplyError` is reported as failing part-way, with its message, never as
"nothing was undone". Its annotations say `destructiveHint: true, idempotentHint: true`.

## How a call runs

The job wrapper and the guard middleware share one routine, in this order (SPEC-approval §5
and §6, and the same order as `mcp-ts`):

1. **Validate.** The SDK has validated the input (jobs) or not (guards). Take `preview` off.
   Build `input` (above). Refuse non-integer numbers (`plan_hash` raises).
2. **Deny.** If the tool is in `deny`, return `is_error` now, before planning, consents or a
   preview.
3. **Plan.** Call the plan function (or `describe`), then hash the plans. A clarification is
   returned as text. No plans means an `is_error` result.
4. **Preview.** If `preview` was set, return the plans as Lens text
   (`structured_content: {"plans": …}`). Nothing is stored.
5. **Retry?** Read the state: `ctx.request_state` in a job, `params["requestState"]` in the
   guard middleware (both plaintext inside the boundary):
   - `None`: carry on;
   - JSON whose object has a `yea` key: step 10;
   - anything else refuses the call.
6. **Consents.** For each plan, in order: `store.get_consent(planHash)`, `check_job_consent`,
   then `consume_once(<grant id>, <its exp>)`; the first that passes runs that plan (step 11).
   `consent_for` does this.
7. **Decide.** `decide(plans, policy, used, now)`, with `used` from `spent(store, policy)` and
   `now` the call time.
   - `run`: `reserve_all`, then step 11. If it returns `None`, ask (step 8), with why "a limit
     filled up while this call was being decided".
   - `denied`: an `is_error` result.
   - `ask` or `out-of-band`: step 8.
8. **Ask.** If the client can take a form (below), `build_form`; if it can't, or the form is
   `None`, step 9. Otherwise ask **per era** (next section), with `round` 1 on a first ask and
   the verdict's round on an ask-again.
9. **Fail closed.** Return `is_error: true` with the plans in Lens, a `job_consent_code` for
   each plan that isn't denied, and: *Ask the user to run `yea approve <code>` in their
   terminal, then call again.* `structured_content` carries `{"plans", "codes"}`. With no
   pinned principal there can be no valid consent, and on a `MemoryStore` `yea approve` can't
   reach the store, so in both cases the result has no codes and says why.
10. **Answer.** `check_state(state["yea"], tool, input_hash, sub, now)`, then
    `consume_once(nonce, exp)`; any failure refuses with one message. The answer is the `yea`
    entry of the input responses (`ctx.input_responses` in a job, `params["inputResponses"]`
    in the guard); it must be an elicitation result, which is dumped to a dict for
    `judge_answer`. A missing or malformed answer counts as not approved. Judge it against the
    plans step 3 recomputed:
    - `run`: step 11;
    - `ask-again`: step 8 with the verdict's round;
    - `out-of-band`: step 9 for that plan;
    - `denied`, `refuse`, `not-approved`: an `is_error` result saying so.
11. **Run.** Call `apply()`. From the moment it returns, no result may say "nothing was run", or
    the client would retry and run it again.
    - If it raises (for `guard`: or returns a mapping with `isError: true` or an input-required
      result): release each reservation (one that can't be released stays held, and never
      hides why the plan failed) and say the approval was used and nothing changed.
    - If it raises a `PartialApplyError` (any exception with `partial = True`, checked
      structurally): it failed after changing something. The result shows its message, which
      says what was left behind, and never "nothing changed". The reservations stay held,
      which can only over-count. As SPEC-mcp-ts.
    - If it succeeds: `settle_all`, then `put_receipt` a job receipt with `id =
      new_receipt_id()`, `service`, `proposal = planHash`, `capability = tool`, `summary`,
      `at`, `effects`, `uses`, `undo = {"until": now + undo_window}` when undoable (else
      `None`), `tool`, `input`, `planHash`, `sub` and `result`. Return the receipt as Lens
      text with `structured_content: {"receipt", "result"}`, or for `guard`, a copy of the
      original result mapping with the receipt in `_meta`.
    - If anything fails after `apply()` succeeded (the result can't be turned into JSON, a
      circular object for example, or `settle_all` or `put_receipt` fails): say the action
      happened and that undo isn't available.

### Asking, per era

The Python SDK has no legacy shim that re-runs a handler, and its `Resolve`/`Elicit` helpers
own `request_state` (they can't carry our nonce). So the plugin asks in one of two ways:

- **2026-07-28 clients** (the request's protocol version is a modern one): return a raw
  `InputRequiredResult(input_requests={"yea": ElicitRequest(params=ElicitRequestFormParams(
  message=…, requested_schema=…))}, request_state=json.dumps({"yea": new_state(…)}))`. The
  client calls the tool again with `input_responses` and the sealed state; the routine re-runs
  from step 1 and reaches step 10.
- **2025-era clients**: a raw `InputRequiredResult` from a tool or middleware fails with
  "Handler returned an invalid result" on these clients, so ask **inside the call**:
  `await session.elicit_form(message=…, requested_schema=…, related_request_id=…)`, which
  takes the core's form schema as is. The state still goes through `new_state`, `check_state`
  and `consume_once` in-process, so rounds, the three-try cap and one-time use are the same;
  ask-again loops inside the same call. After each answer the routine refreshes the clock and
  re-plans, as a 2026 retry (or `mcp-ts`'s re-run) would, so a changed plan asks again and the
  state can expire. Nothing is sealed, because nothing leaves the process. If the client can't
  be asked from here (`NoBackChannelError` on some 2025 HTTP set-ups, or a client that claimed
  elicitation and fails it), the routine takes step 9.

The core's `build_form` output is passed as is in both eras: `message`, and
`requested_schema` with `oneOf` const/title for the plan and a `confirm` string. `elicit_form`
takes a raw schema, so there is no pydantic model to build (`ctx.elicit(message, Model)` can't
express `oneOf` titles). SPEC-approval §4 is updated to say `session.elicit_form`.

**Can the client ask?** `session.client_capabilities` (recorded from `initialize` on 2025, and
per request from the reserved `_meta` on 2026). `elicitation.form`, or a bare
`elicitation: {}`, means yes. `None` means no, so the call takes step 9. The SDK documents
`None` for an anonymous stateless request, which never sent `initialize` or the reserved
`_meta` keys; the legacy-stateless-HTTP test pins it.

## FastMCP 4

`yea_mcp.fastmcp` adapts the same routine to FastMCP 4, whose own middleware is the supported
seam:

- `job()` and `guard()` take a FastMCP server as they take an `MCPServer`, and detect it.
- **`guard()` wraps the tool in place, as `mcp-ts` replaces its handler.** FastMCP can publish
  one tool under many names (a `Namespace` copies it with a new name, a transform wraps it, an app
  tool also answers to a hashed name, search proxies calls), so deciding by name in middleware
  can't be made complete. Instead the plugin's middleware, installed first on that server, turns
  each guarded tool in the server's own provider (every version) into an approval wrapper **in
  place**: the same `Tool` object keeps its name, version, auth, timeout and the rest, but its
  function becomes the wrapper, whose only way to act is a private copy of the original. So every
  route that runs the tool runs the wrapper, including a transform that captured the object
  before the first request. It's checked on every message, so a tool registered, or
  re-registered, after `guard()` is wrapped before anything can call it. Parameters FastMCP fills
  in itself (`Context`, `Depends`) are passed through but aren't part of the input.
- **Guard a tool where it's defined.** A mounted server's tool is guarded on that server (the
  parent's calls go through the child's own middleware); an app's tool isn't supported in v0. A
  guard that can't be kept (the tool isn't the server's own, isn't a function tool, has its own
  `preview`, or runs as a background task), a transform built from a copy of a guarded tool
  taken before it was wrapped, a provider-level rule (`enable`/`disable`) that hands out copies so
  the wrap can't reach the stored tool, or the same function registered under another name,
  refuses **every** tool call on that server with the reason, since the unguarded tool might be
  reachable. Each wrap is verified on a fresh listing.
- `@approvals.job(mcp, ...)` registers the wrapper with `Tool.from_function`, which honours the
  same `__signature__`/`__annotations__` construction.
- On 2026 it returns `InputRequiredToolResult(InputRequiredResult(...))`, the documented way for
  middleware to ask; on 2025 it calls `session.elicit_form(...)` in the call. FastMCP's own
  `ctx.elicit` raises `ToolError` on 2026-07-28, so it isn't used.
- `FastMCP(request_state_security=approvals.request_state_security())` seals the state.
- Capabilities come from `session.client_capabilities`, as above (not `client_params`, which is
  `None` on 2026 when a client omits `clientInfo`).
- **Tasks.** Running task tools needs FastMCP's tasks extension, whose dispatch path hasn't been
  checked, so a guarded task-enabled tool is refused (as above) in v0.

## Results and annotations

As in `mcp-ts`:
- Text content is always Lens for the model, and `structured_content` carries the same data.
- Refusals and failures are `is_error: true` results. The exception is a `request_state` the
  SDK rejects: it answers with an error before our code runs.
- Annotations default to `readOnlyHint: false`, `idempotentHint: false`, and
  `destructiveHint: true` unless the author sets it; `openWorldHint` is the author's.
- Each job tool's `_meta["dev.yea/job"]` is `{"risk", "undoable"}`.

**Guarded tools with an output schema** (decision 6). A client validates `structured_content`
against a tool's `outputSchema` unless the result is an error (checked: `mcp`'s client raises
"has an output schema but did not return structured content"). `MCPServer` generates an
`outputSchema` for any annotated return type, so in Python this is the usual case, not an edge:
a plain `-> str` tool has one. For such a tool, the routine's own results (preview, consent
codes, refusals, not approved) are `is_error: true`, and only the original's result is a
success. The model then sees a preview as an error result; its text says it is a preview.

## The SDK-dependent seams

Each gets its own test and a note in the code:
- the synthesized `__signature__`/`__annotations__` that `func_metadata` and
  `find_context_parameter` read, and the JSON-mode dump of validated arguments;
- `server.middleware` (provisional in `mcp` 2.x): appended after construction, running inside
  the request-state boundary, rewriting params, post-processing `tools/list`, and `call_next`
  returning the wire mapping for `tools/call`;
- the boundary's binding and plaintext hand-off (`ctx.request_state`, `params["requestState"]`);
- `session.elicit_form` on 2025 clients, `NoBackChannelError`, and the 2025 rejection of
  `InputRequiredResult`;
- `session.client_capabilities` per era;
- FastMCP's `InputRequiredToolResult`, `context.copy`, `on_list_tools`, and the transform and
  task paths it refuses;
- the tool registries `job()` and `guard()` read synchronously to find an `undo` tool
  (`MCPServer._tool_manager.get_tool`, FastMCP's `local_provider._components`, matched by tool
  name), as `mcp-ts` reads `_registeredTools`: accessed without a fallback, so an SDK that renames
  them raises at registration instead of skipping the check.

## Package

- `python/mcp/` is a new distribution, `yea-mcp`, imported as `yea_mcp`.
- It depends on `yea-sdk` and `mcp>=2.2,<3`. The FastMCP adapter is the `yea-mcp[fastmcp]`
  extra, with `fastmcp>=4.0.10,<5`.
- Python ≥ 3.10, like `yea-sdk`. The SDK core stays dependency-free; the MCP SDKs are
  dependencies of `yea-mcp` only.

## Code layout

```
python/mcp/src/yea_mcp/__init__.py    yea(), job(), guard(), token_subject(), PartialApplyError, the undo tool
python/mcp/src/yea_mcp/call/          the shared routine: steps 1–11
python/mcp/src/yea_mcp/ask.py         asking per era, and can the client ask
python/mcp/src/yea_mcp/signature.py   the synthesized job signature and the JSON-mode input
python/mcp/src/yea_mcp/guard.py       the server middleware for guarded tools
python/mcp/src/yea_mcp/keys.py        server key, pinned principal, policy and tightening loading
python/mcp/src/yea_mcp/render.py      Lens text and structured_content for plans, receipts and codes
python/mcp/src/yea_mcp/fastmcp.py     the FastMCP 4 middleware and job registration
python/mcp/tests/                     in-memory client tests; security cases in test_security.py
```

## Testing

In-memory clients (`mcp.Client(server, mode=...)` and `fastmcp.Client`), of three kinds: a
2026-07-28 client that elicits (`mode="auto"`), a 2025-era client (`mode="legacy"`), and one
that can't elicit. For each, on both `MCPServer` and FastMCP:

- a job the policy allows runs once, returns a receipt, and reserves and settles its totals;
- a job outside the policy asks. Typing the phrase runs it; a wrong phrase asks again, and the
  third wrong one refuses. Decline, cancel and a missing answer run nothing;
- on 2026, the same state sent twice runs nothing the second time;
- a client that can't ask gets consent codes. After a consent is signed (as `yea approve`
  would), the next call runs, once;
- `preview: true` runs nothing and stores nothing, a denied tool doesn't even preview, and a
  non-boolean `preview` is an error;
- `undo` works within the window, and refuses after it, for another `sub`, and for a receipt
  from another server sharing the store;
- `guard` wraps an existing tool: the original runs only once approved, its result passes
  through with the receipt in `_meta`, and an output-schema tool's own results are errors. The
  original never sees `preview`. An original that returns `is_error` writes no receipt and
  releases its reservations, and a tool with its own `preview` argument is refused;
- a job whose input holds a pydantic model (with aliases), a `date` and an enum gets a stable
  plan hash, and one with `5.5` fails closed;
- `token_subject` returns `""` for a token with no subject;
- the 2025 in-call path takes step 9 on `NoBackChannelError`;
- the start-up and per-call refusals listed under `yea()`;
- a legacy stateless HTTP request takes the consent-code path;
- FastMCP: a transform over a guarded tool is refused at call time, and a task-enabled tool is
  refused by `guard()`;
- `guard()` refuses a `job()` tool, and a job or guard with `revert` refuses a server with its own
  `undo` tool.

Security cases in `test_security.py`, the approval core's list from the MCP side; any fix that
lands in the SDK core also gets its regression test in the core's security tests (repo rule 3):
a denied tool never runs, even with a stored consent; a `high` plan is never offered; an
irreversible plan never auto-runs; a consent for one plan never runs another; a stored copy of
the policy grant never counts as a consent; a `request_state` without our `yea` object is
refused; a guarded tool's original handler never runs before approval, and guarding one server
doesn't guard a same-named tool on another.

## Boundaries

- **Always:** put the decision in the approval core, not here; read the policy and the time on
  every call; fail closed on anything unexpected (a missing key, grant or `sub`, a store error,
  an unexpected `request_state`, a lost back-channel).
- **Ask first:** depend on anything beyond `yea-sdk`, `mcp` and (for the extra) `fastmcp`;
  change the plaintext of the state; add tools other than `undo`; use a private SDK API (such as
  a tool's argument model for `describe`).
- **Never:** trust a `request_state` that isn't ours; run `apply()` from a plan function; treat
  an annotation as enforcement; use sampling; use `Resolve`/`Elicit` or FastMCP's `ctx.elicit`
  for the approval itself.

## Success criteria

- A server author can add one job tool to an existing `MCPServer` or FastMCP server with the
  snippet above, and the three client kinds behave as in Testing.
- The same job behaves the same on stdio and Streamable HTTP, except that legacy stateless HTTP
  fails closed.
- `guard` works on a tool registered by code the author didn't change.
- All approval decisions come from the SDK core, so `conformance/approval.json` covers them, and
  the results match `mcp-ts` for the same calls.

## Decisions

Adopted for v0 under the standing go-ahead; any can be reopened.

1. **2025-era clients are asked inside the call**, not through a re-run shim. The Python SDK has
   no shim, and `Resolve`/`Elicit` can't carry our nonce. The logical rounds, the state and the
   one-time use are the same as on 2026.
2. **`guard` uses `server.middleware`** on `MCPServer` (installed by `guard()` itself, so it
   can't be left off) and FastMCP's `Middleware`, rather than replacing handlers. `mcp`'s
   middleware is provisional, which the seam test watches.
3. **Job tools are plain decorated functions**, whose signature is the input schema, as
   `@server.tool()` already is; `preview` is added to that signature, and `input` is its
   JSON-mode dump.
4. **The request-state key and audience come from `yea()`**, passed to the server as
   `request_state_security`. The SDK does the sealing; the plugin only adds the nonce.
5. **Package:** `yea-mcp` (import `yea_mcp`), with FastMCP as an extra.
6. **Guarded tools with an output schema.** The routine's own results (preview, consent codes,
   refusals, not approved) are `is_error: true`, because clients reject a success result whose
   `structured_content` doesn't match the tool's `outputSchema`. Only the original's result is a
   success, with the receipt in `_meta["dev.yea/receipt"]`. `mcp-ts` does the same (#64).

## Open questions

1. **Timeouts for in-call asks on 2025.** An in-call `elicit_form` waits on the person. The
   SDK's request timeout, if the client sets one, can cut it off; the call then runs nothing,
   which is safe. Proposed: document it; no extra timer in v0.
