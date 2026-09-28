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

server = MCPServer(
    "billing",
    request_state_security=approvals.request_state_security(),
    extensions=[approvals.extension()],
)

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
request-state keys. One `MCPServer` per process is the norm in Python, but the context doesn't
assume it.

| Option | Default | Meaning |
|---|---|---|
| `name` | required | The server's name, `[a-z0-9._-]{1,64}`. Names its key file, and is the request-state audience. |
| `transport` | required | `"stdio"` or `"http"`. Picks the defaults below. |
| `store` | `FileStore()` for stdio, `MemoryStore()` for HTTP | The `ApprovalStore` (SPEC-approval §8). |
| `single_process` | `False` | HTTP only: a promise that one process serves every request. HTTP on a `MemoryStore` must set it. |
| `server_key` | `~/.yea/server/<name>.key` | The server's Ed25519 seed, created on first run with `O_EXCL`, mode `0600`, in a `0700` directory; the same file format as `mcp-ts`. A key file that is a symlink, or readable by others, is refused. Its public key is the service id, and the holder of policy and consent grants. |
| `principal` | `load_principal_key(YEA_PRINCIPAL_PUB)` | The pinned principal public key. If it's missing or refused, nothing auto-runs and no consent is accepted, so every job asks or fails closed. |
| `policy` | `YEA_POLICY` | The signed policy grant: a value starting with `pg1.` is the token, anything else is a path to one. Re-read on every call. |
| `tighten` | `{}` | Unsigned tightening, merged with `~/.yea/policy.json` through `read_tightening`: `deny` is the union, `outOfBand` the stricter. |
| `state_key` | random per process | The ≥ 32-byte request-state key (see below). |
| `sub` | stdio: `lambda ctx: ""`; HTTP: required | Who is calling, from the request context. Used for the state binding and for undo. |

**Start-up refusals.** `yea()` raises, so nothing is served, when `transport="http"` has no
`sub`; a `state_key` is passed with a `MemoryStore`; HTTP runs on a `MemoryStore` without
`single_process=True`; `name` is invalid; or the key file is unsafe.

**Per-call refusals.** `sub` returning `""` on HTTP refuses the call. A policy with a `total`
on a `MemoryStore` without `single_process` refuses too (the policy is read on every call).

**HTTP serves one person in v0**, as in `mcp-ts`. `sub` must return that person's identity from
the transport's authentication. The SDK's `authenticated_principal(ctx)` returns the OAuth
`(client, issuer, subject)` triple; it qualifies only when the token verifier supplies a
subject, since a client id alone names an app, not a person.

### Request state: the SDK seals it

Unlike the TypeScript SDK, `MCPServer` seals every tool's `request_state` itself: its
`RequestStateBoundary` middleware encrypts it with AES-256-GCM and binds it to the tool name, a
hash of the arguments, the authenticated principal and the audience (the server name), with a
600-second lifetime. A tool reads its own plaintext through `ctx.request_state`; a tampered,
expired or rebound token never reaches it (the SDK answers with an error first). It does **not**
stop replay: the same token sent twice runs the handler twice, which is why the core's
`consume_once` on the state nonce stays.

`approvals.request_state_security()` returns `RequestStateSecurity(keys=[state_key],
ttl=600, audience=name)` for `MCPServer(request_state_security=...)` (FastMCP takes the same
argument). Without it the SDK uses a random per-process key, which is fine for stdio but breaks
multi-process HTTP. There is one boundary per server, so a server whose other tools use
`request_state` shares it; our state is the JSON object `{"yea": {…}}`, and anything else
refuses the call.

### `@approvals.job(server, **config)`

Registers the decorated function as a job tool. The function is the **plan** function: its
parameters are the tool's input (as for `@server.tool()`), and it returns `list[Plan]`, a
`clarify(...)` question, or raises. It **must not change anything**: it runs on preview, on
every retry, and again on each round.

| Field | Meaning |
|---|---|
| `name`, `title`, `description`, `annotations` | As in `server.add_tool`. `description` defaults to the docstring. |
| `risk` | The tool's default plan risk. A plan's own `risk` wins; the default is `medium`. |
| `revert` | Optional `revert(receipt) -> Any` (sync or async). With it, plans that set `undo_window` are undoable. It gets the stored job receipt (`input`, `planHash`, `result`, …). |
| `confirm_with` | Optional `confirm_with(plan: HashedPlan, input: dict) -> str`. The phrase the person types; `approve` if it's absent or empty. |

`Plan` is the SDK core's (`summary`, `effects`, `apply`, `uses`, `risk`, `undo_window`,
`data`). For a job, `apply` takes no arguments and may be async; it runs at most once per
approval, and only after the plan is allowed.

**How `preview` gets in.** `MCPServer` builds a tool's input schema and argument model from the
function signature, and validates arguments before calling it. `job()` registers a wrapper whose
`__signature__` is the plan function's parameters plus `preview: bool = False` and a
keyword-only `ctx: Context`, with matching `__annotations__` (the SDK finds the context
parameter through `typing.get_type_hints`, so both are needed). The listed schema then shows
`preview`, the SDK validates the rest, and the wrapper takes `preview` and `ctx` off before
calling the plan function. A plan function with its own `preview` or context parameter, or with
`*args`/`**kwargs`, fails registration.

### `approvals.guard(server, name, **config)`

Turns a tool that's already registered into a job without rewriting it. `config` has
`describe(input)`, which returns `{summary, effects, uses?, risk?, undo_window?}`, plus the
optional `revert` and `confirm_with`.

`MCPServer` has a supported interceptor, so `guard` doesn't replace the handler as `mcp-ts`
must: `approvals.extension()` is an `Extension` whose `intercept_tool_call` checks, for each
`tools/call`, whether the tool is guarded. Extensions are fixed when the server is built, so
the extension goes in `MCPServer(extensions=[...])` and `guard` only registers the tool with it.

- The interceptor sees the raw arguments, before the tool validates them. `describe` gets them
  with `preview` taken off, and must treat them as untrusted.
- The original handler runs through `call_next(ctx)`, which returns a `CallToolResult`. That is
  the plan's `apply`: its result is returned unchanged, with the receipt in
  `_meta["dev.yea/receipt"]`. `is_error: true` or an `InputRequiredResult` counts as a failure:
  reservations are released and no receipt is written.
- The interceptor can't rewrite the arguments the handler gets, so `preview: false` reaches the
  original tool. `MCPServer` argument models ignore unknown fields, so it's harmless; a tool
  whose own schema has a `preview` property is refused on its first guarded call.
- The listed schema of a guarded tool doesn't show `preview` (no supported hook changes
  `tools/list` here). It still works.

### The `undo` tool

`undo(receipt: str)` is registered once per server, the first time a job or guard with
`revert` is added (`server.add_tool` for jobs; the extension's `tools()` would register it too
early, before any job exists). It calls the core's `undo_receipt(store, id, service, sub, now,
revert)` with this server's service id, `sub(ctx)` and the job's `revert`. A receipt from
another server sharing the store, or for a tool with no `revert` here, is "no such receipt".
Its annotations say `destructiveHint: true, idempotentHint: true`.

## How a call runs

The job wrapper and the guard interceptor share one routine, in this order (SPEC-approval §5
and §6, and the same order as `mcp-ts`):

1. **Validate.** The SDK has validated the input (jobs) or not (guards). Take `preview` off.
   Refuse non-integer numbers (`plan_hash` raises).
2. **Deny.** If the tool is in `deny`, return `is_error` now, before planning, consents or a
   preview.
3. **Plan.** Call the plan function (or `describe`), then hash the plans. A clarification is
   returned as text. No plans means an `is_error` result.
4. **Preview.** If `preview` was set, return the plans as Lens text
   (`structured_content: {"plans": …}`). Nothing is stored.
5. **Retry?** Read `ctx.request_state` (plaintext, unsealed by the SDK):
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
   terminal, then call again.* `structured_content` carries `{"plans", "codes"}`.
10. **Answer.** `check_state(state["yea"], tool, input_hash, sub, now)`, then
    `consume_once(nonce, exp)`; any failure refuses with one message. Judge the answer with
    `judge_answer` against the plans step 3 recomputed:
    - `run`: step 11;
    - `ask-again`: step 8 with the verdict's round;
    - `out-of-band`: step 9 for that plan;
    - `denied`, `refuse`, `not-approved`: a plain result saying so.
11. **Run.** Call `apply()`.
    - If it raises (for `guard`: or returns an error or an `InputRequiredResult`): `release_all`
      and say the approval was used and nothing changed.
    - If it succeeds: `settle_all`, then `put_receipt` a job receipt with `id =
      new_receipt_id()`, `service`, `proposal = planHash`, `capability = tool`, `summary`,
      `at`, `effects`, `uses`, `undo = {"until": now + undo_window}` when undoable (else
      `None`), `tool`, `input`, `planHash`, `sub` and `result`. Return the receipt as Lens
      text with `structured_content: {"receipt", "result"}`, or for `guard`, the original
      result with the receipt in `_meta`.
    - If `settle_all` or `put_receipt` fails after `apply()` succeeded: say the action happened
      and that undo isn't available.

### Asking, per era

The Python SDK has no legacy shim that re-runs a handler, and its `Resolve`/`Elicit` helpers
own `request_state` (they can't carry our nonce). So the plugin asks in one of two ways:

- **2026-07-28 clients** (`ctx.protocol_version` is a modern version): return a raw
  `InputRequiredResult(input_requests={"yea": ElicitRequest(params=ElicitRequestFormParams(
  message=…, requested_schema=…))}, request_state=json.dumps({"yea": new_state(…)}))`. The
  client calls the tool again with `input_responses` and the sealed state; the handler re-runs
  from step 1 and reaches step 10.
- **2025-era clients**: a raw `InputRequiredResult` from a tool or an interceptor fails with
  "Handler returned an invalid result" on these clients, so ask **inside the call**:
  `await ctx.session.elicit_form(message=…, requested_schema=…, related_request_id=…)`, which
  takes the core's form schema as is. The state still goes through `new_state`, `check_state`
  and `consume_once` in-process, so rounds, the three-try cap and one-time use are the same;
  ask-again loops inside the same call. Nothing is sealed, because nothing leaves the process.

The core's `build_form` output is passed as is in both eras: `message`, and
`requested_schema` with `oneOf` const/title for the plan and a `confirm` string.
`elicit_form` takes a raw schema, so there is no pydantic model to build (the SDK's
`ctx.elicit(message, Model)` can't express `oneOf` titles).

**Can the client ask?** `ctx.client_capabilities` (the session's, recorded from `initialize` on
2025 and from the request's reserved `_meta` on 2026). `elicitation.form`, or a bare
`elicitation: {}`, means yes. `None` means no, so the call takes step 9. The SDK documents
`None` for an anonymous stateless request, which never sent `initialize` or the reserved
`_meta` keys; the legacy-stateless-HTTP test pins it.

## FastMCP 4

`yea_mcp.fastmcp` adapts the same routine to FastMCP 4, whose own middleware system is the
supported seam:

- `approvals.fastmcp_middleware()` is a `fastmcp.server.middleware.Middleware`. Its
  `on_call_tool` runs the routine for guarded tools; it takes `preview` off the arguments with
  `context.copy(message=…)` before `call_next`, which matters because FastMCP tool schemas set
  `additionalProperties: false`.
- Its `on_list_tools` adds `preview` to guarded tools' listed schemas, since FastMCP has a hook
  for that.
- `@approvals.job(mcp, ...)` registers the wrapper with `Tool.from_function`, which honours the
  same `__signature__`/`__annotations__` construction.
- On 2026 it returns `InputRequiredToolResult(InputRequiredResult(...))`, the documented way for
  middleware to ask; on 2025 it calls `ctx.session.elicit_form(...)` in the call. FastMCP's own
  `ctx.elicit` raises `ToolError` on 2026-07-28, so it isn't used.
- `FastMCP(request_state_security=approvals.request_state_security())` seals the state.
- Capabilities come from the session's client parameters, as above.

## Results and annotations

As in `mcp-ts`:
- Text content is always Lens for the model, and `structured_content` carries the same data.
- Refusals and failures are `is_error: true` results. The exception is a `request_state` the
  SDK rejects: it answers with an error before our code runs.
- Annotations default to `readOnlyHint: false`, `idempotentHint: false`, and
  `destructiveHint: true` unless the author sets it; `openWorldHint` is the author's.
- Each job tool's `_meta["dev.yea/job"]` is `{"risk", "undoable"}`.

**Guarded tools with an output schema.** A client validates `structured_content` against a
tool's `outputSchema` unless the result is an error (checked: `mcp`'s client raises "has an
output schema but did not return structured content"). So for a guarded tool that has one, the
routine's own results (preview, consent codes, refusals, not approved) are returned with
`is_error: true`. Only `apply`'s result, which is the tool's own, is returned as a success.
`mcp-ts` adopts the same rule (decision 6).

## The SDK-dependent seams

Each gets its own test and a note in the code:
- the synthesized `__signature__`/`__annotations__` that `func_metadata` and
  `find_context_parameter` read;
- `Extension.intercept_tool_call` for `guard`, and its fixed-at-construction extension list;
- `ctx.request_state` being plaintext inside the boundary, and the boundary's binding;
- `ctx.session.elicit_form` on 2025 clients, and the 2025 rejection of `InputRequiredResult`;
- `ctx.client_capabilities` per era;
- FastMCP's `InputRequiredToolResult`, `context.copy`, and `on_list_tools`.

## Package

- `python/mcp/` is a new distribution, `yea-mcp`, imported as `yea_mcp`.
- It depends on `yea-sdk` and `mcp>=2.2,<3`. The FastMCP adapter is the `yea-mcp[fastmcp]`
  extra, with `fastmcp>=4.0.10,<5`.
- Python ≥ 3.10, like `yea-sdk`. The SDK core stays dependency-free; the MCP SDKs are
  dependencies of `yea-mcp` only.

## Code layout

```
python/mcp/src/yea_mcp/__init__.py    yea(), job(), guard(), the undo tool
python/mcp/src/yea_mcp/call.py        the shared routine: steps 1–11
python/mcp/src/yea_mcp/ask.py         asking per era, and can the client ask
python/mcp/src/yea_mcp/signature.py   the synthesized job signature that carries preview
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
- `preview: true` runs nothing and stores nothing, and a denied tool doesn't even preview;
- `undo` works within the window, and refuses after it, for another `sub`, and for a receipt
  from another server sharing the store;
- `guard` wraps an existing tool: the original runs only once approved, its result passes
  through with the receipt in `_meta`, and an output-schema tool's refusals are errors;
- the start-up and per-call refusals listed under `yea()`;
- a legacy stateless HTTP request takes the consent-code path.

Security cases in `test_security.py`, the approval core's list from the MCP side; any fix that
lands in the SDK core also gets its regression test in the core's security tests (repo rule 3):
a denied tool never runs, even with a stored consent; a `high` plan is never offered; an
irreversible plan never auto-runs; a consent for one plan never runs another; a stored copy of
the policy grant never counts as a consent; a `request_state` without our `yea` object is
refused; and a guarded tool's original handler never runs before approval.

## Boundaries

- **Always:** put the decision in the approval core, not here; read the policy and the time on
  every call; fail closed on anything unexpected (a missing key, grant or `sub`, a store error,
  an unexpected `request_state`).
- **Ask first:** depend on anything beyond `yea-sdk`, `mcp` and (for the extra) `fastmcp`;
  change the plaintext of the state; add tools other than `undo`; use a private SDK API.
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
2. **`guard` uses the SDK's `Extension` interceptor** on `MCPServer`, and FastMCP's
   `Middleware`, rather than replacing handlers. Both are supported seams.
3. **Job tools are plain decorated functions**, whose signature is the input schema, as
   `@server.tool()` already is; `preview` is added to that signature.
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
