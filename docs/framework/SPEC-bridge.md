# Spec: bridge

`yea mcp <url>…` exposes YEA services to MCP clients. Today it's a hand-written server for the
2025-era protocol (`ts/src/mcp.ts`), with four generic tools (`yea_ask`, `yea_intent`,
`yea_commit`, `yea_undo`) and a yes/no elicitation for consent. This moves it onto the MCP
SDK and `@yea-protocol/mcp` ([SPEC-mcp-ts.md](SPEC-mcp-ts.md)). It then speaks 2026-07-28 and,
through the SDK's legacy shim, the 2025 era. Each remote capability becomes its own tool, and
consent is typed, not yes/no.

Issue: [#40](https://github.com/yea-protocol/yea/issues/40). Map: [README.md](README.md).

Status: built in [#73](https://github.com/yea-protocol/yea/issues/73), except `--approve-here`
(steps 6–7's form and in-client signing), which waits for decision 4. Until then the bridge
signs nothing: consent codes are the only way to approve.

## Objective

```sh
yea mcp yeas://shop.example https://cal.example.com/yea
```

The MCP client sees one tool per remote capability, named for it (`shop_order`,
`calendar_reschedule`, `calendar_find`), plus the utilities `yea_undo`, `yea_expand` and
`yea_consent`. From the model's side, `calendar_reschedule` is an ordinary tool:

- It runs and returns a receipt when the **remote service's own grant check** lets it
  auto-commit.
- Otherwise the call returns the proposals and a consent code for each. The person approves
  one with `yea approve <code>` (where the principal key is), then hands the signed consent
  back, and the next identical call commits it.
- With `--approve-here`, a person at a client that can show forms approves by typing the
  phrase instead, and the bridge signs the consent with a principal key on this machine
  (decision 4).

**The authority stays with the service.** Unlike a server built with `@yea-protocol/mcp`, the
bridge has no policy of its own. The remote service checks the agent's grants, auto-commits
what they allow, and demands a consent grant for the rest (SPEC.md §4.3.1, §6.6). The bridge
only carries that to MCP: it shows the proposals, relays the consent, and commits.

## Tools

On start, the bridge sends `HELLO` to each service with a large budget. It `EXPAND`s any
`more` handles, so it gets every capability and its `params`, then builds the tools:

| Remote capability | MCP tool | Input schema |
|---|---|---|
| `kind: ask` | read tool, `readOnlyHint: true` | from the capability's compact `params` (SPEC.md §4.1.1) |
| `kind: intent` | job tool, `destructiveHint: true` | the same, plus optional `goal`, `preview` and `proposal` |
| — | `yea_expand({ service, handle })` | fetches an elided part of any result (`EXPAND`) |
| — | `yea_undo({ service, receipt })` | undoes a receipt within its window (`UNDO`) |
| — | `yea_consent({ token })` | hands a consent signed with `yea approve` back to the bridge |

- **Tool names are deterministic and safe everywhere.** Many clients, and model APIs behind
  them, accept only `[A-Za-z0-9_-]{1,64}`. So the name is the capability name with every
  other character replaced by `_`, cut to 57 characters so a suffix still fits in 64.
  - Two tools that would get the same name (two services sharing a capability, or `a.b`
    and `a_b`) both get a suffix: `_` and the first 6 b64url characters of
    `sha256(service id + "/" + capability)`.
  - The `yea_` prefix is reserved (matched as `/^yea[_-]/i`): a capability whose name starts
    with it gets the suffix. So does an empty name.
  - A name that still clashes after its suffix (with another tool, or a utility) isn't served,
    and stderr says so. Nothing is ever shadowed.
  - `_meta['dev.yea/service']` and `_meta['dev.yea/capability']` carry the real names.
- **Service ids must be unique.** Two URLs whose `BRIEF`s claim the same `service.id` make the
  bridge refuse to start, naming both. The id is self-declared, and it's what proofs and
  consents bind to.
- **Parameters.** The compact schema maps to JSON Schema:
  - `string`, `int`, `number`, `bool`, `date` and `datetime` map to string, integer, number,
    boolean, and string with `format: date` or `date-time`;
  - `any` maps to no constraint;
  - a `"a|b|c"` enum maps to `enum`, and `T[]` (enum arrays included) to arrays;
  - a one-element array of an object schema (`[{…}]`) maps to an array of that object;
  - nested objects map to objects, and a name ending in `?` is optional;
  - the text after ` — ` becomes the `description`.

  The service validates params itself, so the tool's Standard Schema passes values through
  unchanged. A job capability's param named `goal`, `preview` or `proposal` makes that tool
  refuse to be built (named on stderr), rather than shadow the bridge's own fields. Read tools
  have no such fields, so they're built as usual. Any tool with a param name, at any depth,
  outside `^[a-zA-Z0-9_.-]{1,64}$` isn't served either (named on stderr): some model APIs
  reject a whole tool list over one such name.
- **Service text is capped.** Capability and service summaries and param descriptions are
  made one line and cut to about 300 characters in tool descriptions, schemas and the
  instructions. In per-capability mode a service gets at most 200 tools (the rest are named
  on stderr; `--tools generic` serves them all).
- **Too many tools, per service.** A service with more than 25 capabilities (the OpenAPI
  adapter can expose hundreds) gets two generic tools instead: `<service>_ask` and
  `<service>_intent`, taking `{ capability, params, goal?, preview?, proposal? }`.
  - `<service>` is the service id, sanitized and cut to 40 characters, so the two names never
    truncate into each other. They go through the same collision and `yea_` rules; their suffix
    hashes `service id + "/" + "ask"` (or `"intent"`).
  - A service with no capabilities of a kind gets no generic tool for it.
  - Other services keep their per-capability tools.
  - `--tools generic|per-capability` forces one mode for every service.
  - A generic intent call runs the same steps as a per-capability one.
  - The instructions list a generic service's capabilities from the `BRIEF` kept at start-up
    (no second `HELLO`): as many full Lens lines as fit the bridge's budget, then the rest by
    name.
- **Refreshing.** Capabilities are read at start; a `--watch` that re-reads them comes later.

## How a job tool call runs

The bridge keeps **pending proposals** in the `bridge()` closure, which lives for the
process, not in the server factory (`serveStdio` calls the factory more than once).
- **Keyed** by tool and input hash, with `goal`, `preview` and `proposal` left out. The input
  hash is `sha256` of the params as JSON with sorted keys, not `canonical`: a service's
  `number` params may be floats, which canonical JSON refuses. The hash never leaves the
  process. (A generic tool's key includes the capability too.)
- **Bounded** to 256 entries, the oldest dropped first.
- **Expiring one by one.** Only proposals with at least 2 minutes left are kept, and only
  those get codes, so a code is never handed out for a proposal the bridge doesn't keep or
  just before it expires. Proposals that arrive with less than 2 minutes left are shown as
  not offered. The 2-minute rule is for handing out codes only: a kept proposal with less
  left loses its code ("no new codes") but stays, so an approval already saved still commits
  it, until it really expires. The entry goes once it commits, once none of its proposals are
  left, or when a call finds only uncoded proposals and no saved approval (it then starts over
  with a fresh `INTENT` rather than wait out the last minutes).

1. **Deny.** If the capability is in the local unsigned `deny` list (`~/.yea/policy.json`,
   SPEC-approval §2), refuse before anything else, previews included. Entries match either
   the capability name or `service-id/capability`, never the tool name, so a suffix can't
   dodge them. The bridge honours local tightening, and never loosens anything. A
   `policy.json` that can't be read, isn't JSON, isn't an object, or has a bad `deny` or
   `outOfBand` refuses every job call, since its `deny` can't be known (unknown fields only
   warn). `@yea-protocol/mcp`'s job tools do the same.
2. **Preview.** With `preview: true`, send `INTENT` without `auto`, and return the proposals
   as Lens. Nothing is stored.
3. **Pending.** If there are pending, unexpired proposals for this tool and input:
   - **A chosen proposal?** If the call names `proposal`, this step acts on that id only; see
     below.
   - **A consent for one of them?** If the bridge's consent store holds one for a pending
     proposal's hash (from `yea_consent`, or saved by `yea approve` on this machine),
     `COMMIT` that proposal with the agent's grants plus the consent, then drop the entry
     and return the receipt. If that `COMMIT` fails without the proposal going stale (a
     `forbidden`, a bad proof, the service refusing the consent), the service's error is
     returned and that consent is set aside for this entry: it's never retried, so identical
     calls don't replay the failure, and a fresh approval of the same proposal can replace it. `yea_consent`
     refuses a consent set aside this way, saying the service refused it and to approve
     again.
   - **An approval round?** If the call carries our state (below), go to step 7. A call
     carrying our state with no pending entry is refused as a bad state; it never falls
     through to a fresh `INTENT`. Until `--approve-here` exists the bridge mints no state, so
     a call carrying any state is refused, pending entry or not.
   - **The chosen proposal.** If the call names `proposal` (an id from this entry's list),
     `COMMIT` that proposal, and only it: with the agent's grants, plus that proposal's own
     saved consent if there is one (never another proposal's). The service decides: a
     `RECEIPT` means the grant allowed it (an irreversible action within the grant, say),
     and `consent_required` returns that proposal's code. This is the protocol's agent
     commit, which the old `yea_commit` offered; the model never supplies a consent.
   - **Otherwise,** return the same proposals and codes again, so an approval in progress
     isn't orphaned.

   A `not_found`, `expired` or `conflict` from the service drops the entry and continues at
   step 4. A consent from the store is used only if it passes every `yea_consent` check below.

   A call naming `proposal` with no pending entry for its input (it expired, was used, or the
   bridge restarted) is refused, not sent as a fresh `INTENT`: the id the model names could
   be for any of the old proposals, and a fresh `auto` would commit only the first.
4. **Auto.** Send `INTENT` with `auto: true` and the agent's grants and proof.
   - A `RECEIPT` means the service's grant check allowed it: return the receipt.
   - `CLARIFY` becomes a clarification result.
   - An error is returned as `isError`.
5. **Proposals.** Check each proposal as the current bridge's `consentFor` does:
   - its hash recomputes;
   - its `uses` is well formed;
   - its capability is this tool's.

   Proposals that fail are dropped, and said so. The rest are stored as pending. Each also
   becomes a `HashedPlan` for the approval core: `planHash` is the proposal's hash, which the
   consent must bind; `risk`, `undoable` (undo not null), `summary`, `effects` and `uses`
   come from the proposal.

   Auto-commit only ever covers the first proposal, and only if it's undoable (SPEC.md
   §4.3.1). For an irreversible proposal, or any but the first, that the grant allows, the
   model commits it by calling again with `proposal` (step 3), or the person approves it in
   the form (step 7). Either way the service commits it without a consent.
6. **Codes, or a form.** The principal is the root `iss` of the grants sent on the `INTENT`;
   §4.4 requires the same principal for the commit.
   - No grants at all means the proposals can never be committed (§4.4). The call returns
     them with no codes and says to run `yea grant` for this agent.
   - Grants from more than one principal also get no codes, and an `isError` saying why.
   - **By default, and whenever the form can't be used:** return the proposals and, for each
     offerable one (not denied), a protocol consent code. The code is `consentCode`, with a
     `ConsentRequest` built from the proposal (`proposal`, `hash`, `service`, `capability`,
     `summary`, `expires` = the proposal's `expires`) and that principal, plus the proposal
     as detail and the agent's public key as `agent`, so `yea approve` elsewhere signs to the
     right key. The message says: *Ask the user to run `yea approve <code>` where their
     principal key is, then paste the printed consent back to you and call `yea_consent`
     with it, then call this tool again.* (`yea approve` asks y/N for protocol proposals; it
     doesn't ask for a phrase.)
   - A result that returns proposals for approval isn't `isError`: nothing ran, the first line
     says so, and the model may still commit one within the grant with `proposal`. The no-grants
     and many-principals results are `isError`.
   - **With `--approve-here`**, when the client can take a form and the principal key on this
     machine matches: `buildForm` the pending proposals (`high` and denied ones aren't
     offered), and return `inputRequired` with a sealed state (`newState`), as
     `@yea-protocol/mcp` does.
7. **Answer** (`--approve-here` only).
   - The retry does **not** send `INTENT` again: the pending proposals are the recomputed
     plans, so the chosen hash still matches.
   - `checkState`, then `consumeOnce(nonce)`, then `judgeAnswer`. On `run`:
     1. `COMMIT` the proposal with the agent's grants.
     2. A `RECEIPT` means the grant allowed it; done.
     3. On `consent_required`, run `consentFor(err, c, p)`, unchanged from today, which
        checks the service's consent request against the proposal the person saw. Also
        require `err.consent.principal` to equal the grants' `iss` and the local principal
        key.
     4. Sign the consent grant with the principal key, issued to the agent's key.
     5. `COMMIT` again with it.
   - A `COMMIT` that fails in transport is retried as is before anything is reported. It's
     idempotent (§4.4), and a commit that went through must not look pending.
   - `ask-again`, `refuse`, `not-approved`, `denied` and `out-of-band` behave as in mcp-ts.
     Out-of-band proposals fall back to codes.

**`yea_consent({ token })`** saves a consent only if all of these hold:
- it's a `pg1.` grant of a single root block, with a valid signature;
- `iss` is the pending entry's principal, and the holder is the agent's key;
- its caveats are exactly SPEC.md §6.6's five: `svc`, `verbs: ["COMMIT"]`, `can`, `only` and
  `exp`;
- `svc`, `can` and `only` match a pending proposal (service id, capability and hash);
- `exp` is in the future.

Anything else is refused, and nothing is written. A valid consent is saved in the agent's
`~/.yea/consents` under its `only` hash, never over a different valid consent for the same
hash, and the result says which pending proposal it's for. It signs nothing and commits
nothing. Passing a consent through the model is safe: it's signed by the principal, commits
one exact proposal at one service, and still needs the agent key's proof.

## Read tools, expand and undo

- **Read tools** send `ASK` with the params and the agent's budget, and return the Lens.
  Elided parts come back with a `yea_expand` hint.
- **`yea_expand`** sends `EXPAND` with the handle. Handles are bound to the agent's key by
  the service (SPEC.md §4.6).
- **Every result is rendered by the bridge.** A reply's own `lens` field is ignored, and every
  service-written string outside `data` and `result` is made one line (control characters, line
  separators and bidi marks escaped), so a hostile summary can't forge a line of ours.
- **`yea_undo`** sends `UNDO` with the agent's grants. The service checks the window and the
  principal.

## Package and compatibility

- **Code.** The bridge becomes `mcp/src/bridge.ts`, exported as `@yea-protocol/mcp/bridge`,
  with `bridge(clients, options)` returning a server factory. It uses mcp-ts's result
  helpers (render.ts) and the approval core's form and state; the ones it needs are
  exported. It doesn't reuse `runJob`, whose plans come from a local handler and a local
  policy.
- **The command.** `yea mcp` moves to the CLI package (`cli/`), which depends on
  `@yea-protocol/mcp`: `cli/bin/yea.js` handles `mcp` itself and passes everything else to
  the SDK's CLI. The SDK can't import `@yea-protocol/mcp` without a cycle.
- **The SDK core.** It drops `ts/src/mcp.ts` and its `./mcp` export, so it stays
  zero-dependency. `ts/src/tools.ts` stays, because `yea test-drive` uses its generic tools
  with the Claude API, and the SDK root exports `TOOLS` and `INSTRUCTIONS` for
  `bench/run.ts`.
- **`yea approve`.** A protocol code may carry an `agent` field, the key the consent should be
  issued to. It's unsigned, so `yea approve`:
  - checks its format, and prints it next to the proposal;
  - on a machine with its own agent key that differs, requires `--to` to say which;
  - on a machine without one (the key-on-another-device case), also requires `--to`: the
    unsigned `agent` is never used on its own. The refusal prints the code's agent as the
    suggested value, with a short fingerprint (the first 8 b64url characters of its
    sha256), so the person checks it and passes it deliberately. The fingerprint is shown
    again next to the proposal before the y/N.

  After the y/N, it prints the signed consent on stdout, to paste back to the agent (which
  hands it to `yea_consent`), and saves it in `~/.yea/consents` only when this machine's agent
  key is the one it's issued to.

  `agent` changes no bytes SPEC.md pins, since codes are a tooling format and decoders ignore
  unknown fields. Python's protocol code builder mirrors it, and a protocol-code vector is
  added.
- **`yea install`.** The config it writes (`npx -y @yea-protocol/cli mcp <urls>`) doesn't
  change. The tool names do, so these are updated:
  - `plugins/yea/skills/yea/SKILL.md`;
  - the server instructions;
  - `AGENT_BLOCK` in `ts/src/setup.ts` (written into CLAUDE.md and AGENTS.md);
  - site/guide/integrations.md: "don't auto-approve `yea_commit`" becomes "don't
    auto-approve tools marked `destructiveHint`".

  Nothing has been released with the old names, so there's no migration.
- **Benchmarks.** The live agent-eval numbers in the README were measured with the old tools.
  Re-running them costs money, so it waits for James; until then, the README says which
  version they measured.
- **Tests.** `ts/test/mcp.test.ts` and the bridge's cases in `ts/test/security.test.ts` move
  with the code, and are rewritten for the new tools.

## Start-up limits

- `HELLO` is sent with a budget of 100,000, and at most 64 `EXPAND`s read the capability list;
  a service that needs more is reported as unreachable.
  A capability entry that doesn't parse, or repeats a name, is skipped and reported.
- The bridge's clients send the agent's grants only. Consents stay in `~/.yea/consents` and are
  read by proposal hash when a pending proposal is committed.

## Testing

Against the example services (`calendar`, `shop`) served in-process, with the in-memory MCP
clients from `@yea-protocol/mcp`'s tests (2026, 2025 through the shim, and no elicitation):

- tools are built from `HELLO` with `EXPAND`ed `more`: names, suffixes on collision, the
  reserved `yea_` prefix, schemas (including `any`, `[{…}]` and enum arrays), annotations,
  and a refused `goal`/`preview` param;
- duplicate service ids refuse to start;
- the per-service generic fallback past 25 capabilities;
- a call the agent's grant allows auto-commits in one call;
- by default, a call over the grant returns codes;
- a call naming `proposal` commits an irreversible proposal the grant allows, and gets a code
  when it doesn't;
- no grants means no codes and a `yea grant` hint;
- float params hash and cache;
- `yea approve` (with the code's `agent`) plus `yea_consent` plus the same call commits that
  proposal, once;
- a re-call before approval returns the same codes, and doesn't orphan the approval;
- an expired or discarded pending proposal falls back to a fresh `INTENT`;
- with `--approve-here` (not built yet, TODO #73):
  - a typed phrase commits;
  - the retry sends no `INTENT`;
  - a consent is signed only after `consent_required`;
  - a wrong phrase asks again, and decline commits nothing;
  - a `high` proposal gets a code, not the form;
- `preview` commits nothing; `deny` refuses first, including previews, and matches the
  capability after a suffix;
- `yea_expand`, `yea_undo` and `yea_consent` work. `yea_consent` refuses a policy grant, a
  delegated or extra-caveat grant, another principal's or another holder's grant, one for no
  pending proposal, an expired one, and an overwrite of a valid consent;
- `yea approve` requires `--to` when a code's `agent` differs from the local agent key;
- security:
  - the model can't approve by any argument;
  - a consent for one proposal never commits another;
  - a state replayed after use commits nothing;
  - a proposal that fails its hash check is never shown or signed;
  - a hostile service's names and summaries can't shadow utility tools or forge lines.

## Boundaries

- **Always:**
  - the service decides; the bridge shows, relays and commits;
  - codes by default;
  - sign only with `--approve-here`, after a typed approval of that exact proposal and the
    service's own consent request;
  - fail closed.
- **Ask first:**
  - any policy of the bridge's own;
  - auto-approving anything the service didn't auto-commit;
  - making in-client signing the default.
- **Never:**
  - sign a consent the person didn't type the phrase for;
  - loosen anything;
  - pass the principal key or any unsigned approval through the model.

## Success criteria

- In Claude Code, `yea install` then `yea mcp` shows the example services' capabilities as
  tools. An order over the grant returns a code; `yea approve` plus `yea_consent` then
  commits it. With `--approve-here` and a local principal key, the same order asks for the
  typed phrase in the client and commits.
- In Claude Desktop (no elicitation), the code path works the same.
- The SDK core has no MCP code, and still has no dependencies.

## Decisions

Adopted for v0 under the standing go-ahead; any can be reopened.

1. **One tool per capability, with a per-service generic fallback past 25 capabilities.**
   This follows the map's rule without drowning clients, and one large service doesn't change
   the others.
2. **No local policy.** The service's grant is the policy, so a second policy in the bridge
   could only confuse. Local unsigned `deny` and `outOfBand` still apply, because they only
   tighten.
3. **Pending proposals are kept in memory** by the running bridge. The protocol binds a
   consent to the exact proposal, so the bridge must commit the one the person approved, not
   a fresh one. A bridge restarted between `yea approve` and the re-call finds no pending
   proposal, and asks again.
4. **In-client signing is opt-in (`--approve-here`), pending James.** Signing with the
   principal key inside the chat client is the path SPEC.md §6.6 warns about:
   - some clients auto-fill forms or route elicitation to a model;
   - the phrase is printed in the form;
   - a principal key on the agent's machine is reachable by a shell-capable agent.

   So the default is consent codes approved where the key is, and signing here takes an
   explicit flag the person sets. Whether to offer the flag at all is on the issue as
   `status/needs-james`.
5. **The model can still commit within the grant.** A job tool takes an optional `proposal`,
   which commits a pending proposal with the agent's grants only. The service then decides,
   as with the old `yea_commit`. Irreversible actions the person's grant allows don't need
   `yea approve` each time. Anything the grant doesn't allow still needs a signed consent,
   which the model can't make.
