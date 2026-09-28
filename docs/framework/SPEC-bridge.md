# Spec: bridge

`yea mcp <url>…` exposes YEA services to MCP clients. Today it's a hand-written server for the
2025-era protocol (`ts/src/mcp.ts`), with four generic tools (`yea_ask`, `yea_intent`,
`yea_commit`, `yea_undo`) and a yes/no elicitation for consent. This moves it onto the MCP
SDK and `@yea-protocol/mcp` ([SPEC-mcp-ts.md](SPEC-mcp-ts.md)). It then speaks 2026-07-28 and,
through the SDK's legacy shim, the 2025 era. Each remote capability becomes its own tool, and
consent is typed, not yes/no.

Issue: [#40](https://github.com/yea-protocol/yea/issues/40). Map: [README.md](README.md).

## Objective

```sh
yea mcp yeas://shop.example https://cal.example.com/yea
```

The MCP client sees one tool per remote capability, named for it (`shop.order`,
`calendar.reschedule`, `calendar.find`), plus `yea_undo` and `yea_expand`. From the model's
side, `calendar.reschedule` is an ordinary tool:

- It runs and returns a receipt when the **remote service's own grant check** lets it
  auto-commit.
- Otherwise the person sees the proposals in their client and types the phrase to approve
  one, and the bridge signs the consent and commits it.
- When the client can't ask, or the principal key isn't on this machine, the call returns
  consent codes for `yea approve`, and the next identical call commits.

**The authority stays with the service.** Unlike a server built with `@yea-protocol/mcp`, the
bridge has no policy of its own. The remote service checks the agent's grants, auto-commits
what they allow, and demands a consent grant for the rest (SPEC.md §4.3.1, §6.6). The bridge
only carries that to MCP: it shows the proposals, collects the person's approval, and signs
or relays the consent.

## Tools

On start, the bridge sends `HELLO` to each service and builds its tools from the `BRIEF`:

| Remote capability | MCP tool | Input schema |
|---|---|---|
| `kind: ask` | read tool, named for the capability, `readOnlyHint: true` | from the capability's compact `params` (SPEC.md §4.1.1) |
| `kind: intent` | job tool, named for the capability, `destructiveHint: true` | the same, plus optional `goal` and `preview` |
| — | `yea_expand({ service, handle })` | fetches an elided part of any result (`EXPAND`) |
| — | `yea_undo({ service, receipt })` | undoes a receipt within its window (`UNDO`) |

- **Tool names.** The capability name, with any character outside `A–Z a–z 0–9 _ . -` replaced
  by `_`. Two services with the same capability name get the service's short id as a
  prefix (`cal.example.com/calendar.find`). The service id goes in `_meta['dev.yea/service']`.
- **Schemas.** The compact schema maps to JSON Schema:
  - `string`, `int`, `number`, `bool`, `date` and `datetime` map to string, integer, number,
    boolean, and string with `format: date` or `date-time`;
  - a `"a|b|c"` enum maps to `enum`;
  - `T[]` maps to arrays;
  - nested objects map to objects, and a name ending in `?` is optional;
  - the text after ` — ` becomes the `description`.

  The service validates params itself, so the MCP schema is a guide for the model, not the
  check.
- **Too many tools.** A service with many capabilities (the OpenAPI adapter can expose
  hundreds) would swamp the client. Past 40 tools in total, or with `--tools generic`, the
  bridge falls back to two generic tools, `yea_ask({ service, capability, params })` and
  `yea_intent({ service, capability, params, goal? })`, plus `yea_expand` and `yea_undo`. It
  says so on stderr and in the server's instructions. `--tools per-capability` forces one
  tool per capability.
- **Refreshing.** Capabilities are read at start. A `yea mcp --watch` that re-reads them and
  sends `notifications/tools/list_changed` comes later.

## How a job tool call runs

1. **Preview.** With `preview: true`, send `INTENT` without `auto`, and return the proposals
   as Lens. Nothing is stored.
2. **Deny.** If the tool is in the local unsigned `deny` list (`~/.yea/policy.json`,
   SPEC-approval §2), refuse before anything else. The bridge honours local tightening. It
   never loosens anything, because it has no policy that could.
3. **A stored consent?** For this tool and input, is there a pending proposal the person has
   since approved with `yea approve`? That is, a saved consent grant for its proposal hash,
   in the principal's consent store, that hasn't expired. If so, `COMMIT` that proposal with
   the consent, and return the receipt.
4. **Auto.** Send `INTENT` with `auto: true` and the agent's grants and proof.
   - A `RECEIPT` means the service's grant check allowed it: return the receipt.
   - `CLARIFY` becomes a clarification result.
   - An error is returned as `isError`.
5. **Proposals.** The service didn't auto-commit, so the person has to approve. Each proposal
   is turned into a `HashedPlan` for the approval core:
   - `planHash` = the proposal's own hash, which a consent grant must bind;
   - `risk` and `undoable` (undo not null) come from the proposal;
   - `plan.summary`, `effects` and `uses` come from the proposal.

   The proposals are remembered for step 3, keyed by tool and input hash, until they expire.
6. **Ask**, if the client can take a form (SPEC-mcp-ts's rule) and the principal key is on
   this machine and matches the service's `consent.principal`:
   - `buildForm` the proposals: `high` ones and denied ones aren't offered;
   - return `inputRequired` with a sealed state (`newState`), as `@yea-protocol/mcp` does.
7. **Answer.** Run `checkState`, then `consumeOnce(nonce)`, then `judgeAnswer`. On `run`:
   - re-check the proposal against the one the service sent (`consentFor`'s rules: same id,
     hash, capability and service, and the proposal hash recomputes);
   - sign a consent grant for it with the principal key (the protocol's consent grant, issued
     to the agent's key);
   - `COMMIT` with it, and return the receipt.

   `ask-again`, `refuse`, `not-approved`, `denied` and `out-of-band` behave as in mcp-ts.
8. **Fail closed.** Return the proposals and a protocol consent code (`consentCode` with the
   proposal as detail) for each offerable proposal. The message says: *Ask the user to run
   `yea approve <code>`, then call again.* The next identical call finds the approval at
   step 3.

The principal key signs only after the person has typed the phrase for that exact proposal.
The model never approves. A principal key on the agent's own machine is weak, as the security
guide already says: an agent with a shell could sign for itself. So the bridge prefers the
key elsewhere, and falls back to consent codes when it isn't here.

## Read tools, expand and undo

- **Read tools** send `ASK` with the params and the agent's budget, and return the Lens.
  Elided parts come back with a `yea_expand` hint.
- **`yea_expand`** sends `EXPAND` with the handle. Handles are bound to the agent's key by
  the service (SPEC.md §4.6).
- **`yea_undo`** sends `UNDO` with the agent's grants. The service checks the window and the
  principal.

## Package and compatibility

- **Code.** The bridge becomes `mcp/src/bridge.ts`, exported as `@yea-protocol/mcp/bridge`,
  with `bridge(clients, options)` returning a server factory. The CLI (`@yea-protocol/cli`)
  depends on `@yea-protocol/mcp`, and `yea mcp` serves it with `serveStdio`.
- **The SDK core.** It drops `ts/src/mcp.ts` and its `./mcp` export, so it stays
  zero-dependency. `ts/src/tools.ts` stays, because `yea test-drive` uses its four generic
  tools with the Claude API. `bench/run.ts` imports `TOOLS` and `INSTRUCTIONS` from the SDK
  root instead of `./mcp`.
- **`yea install`.** The config it writes (`npx -y @yea-protocol/cli mcp <urls>`) doesn't
  change. The tool names do, so `plugins/yea/skills/yea/SKILL.md` and the server
  instructions are updated to "call the capability's tool; approval appears in your client".
  Nothing has been released with the old names, so there's no migration.
- **Tests.** `ts/test/mcp.test.ts` and the bridge's cases in `ts/test/security.test.ts` move
  with the code, and are rewritten for the new tools.

## Testing

Against the example services (`calendar`, `shop`) served in-process, with the in-memory MCP
clients from `@yea-protocol/mcp`'s tests (2026, 2025 through the shim, and no elicitation):

- tools are built from `HELLO`: names, schemas, annotations, and the collision prefix;
- a call the agent's grant allows auto-commits in one call, and returns the receipt;
- a call over the grant asks. Typing the phrase signs a consent, commits, and returns the
  receipt. A wrong phrase asks again; decline commits nothing;
- a `high` proposal is never offered in the form, and gets a code;
- without elicitation, or without a local principal, the call gets consent codes. After
  `yea approve` (the existing protocol path), the next identical call commits that proposal,
  once;
- `preview` commits nothing; `deny` refuses first;
- `yea_expand` and `yea_undo` work;
- past 40 capabilities, the generic tools appear instead;
- security:
  - the model can't approve by any argument;
  - a consent for one proposal never commits another;
  - a state replayed after use commits nothing;
  - a proposal that changed at the service since it was shown is refused (the consent
    check).

## Boundaries

- **Always:** the service decides; the bridge shows, collects and relays. Sign only after a
  typed approval of that exact proposal. Fail closed to consent codes.
- **Ask first:** any policy of the bridge's own; auto-approving anything the service didn't
  auto-commit.
- **Never:** sign a consent the person didn't type the phrase for; loosen anything.

## Success criteria

- `yea install` then `yea mcp` in Claude Code shows the example services' capabilities as
  tools. An order over the grant asks with the typed phrase and then commits. In Claude
  Desktop (no elicitation), the same order returns a code, and after `yea approve` it
  commits.
- The SDK core has no MCP code, and still has no dependencies.

## Decisions

Adopted for v0 under the standing go-ahead; any can be reopened.

1. **One tool per capability, with a generic fallback past 40 tools.** This follows the map's
   rule without drowning clients.
2. **No local policy.** The service's grant is the policy, so a second policy in the bridge
   could only confuse. Local unsigned `deny` and `outOfBand` still apply, because they only
   tighten.
3. **Pending proposals are kept in memory** by the running bridge. The protocol binds a
   consent to the exact proposal, so the bridge must commit the one the person approved, not
   a fresh one. A bridge restarted between `yea approve` and the re-call finds no pending
   proposal, and asks again.
