# Spec: approval

The approval contract for YEA's framework plugins. It decides when a job tool's plan runs on
its own, when a person must approve it, how that approval is asked for and checked, and how
an action is undone. `mcp-ts` and `mcp-py` implement the MCP side of it. The logic itself lives
in the SDK core of both languages and passes shared conformance cases.

Issue: [#37](https://github.com/yea-protocol/yea/issues/37). Map: [README.md](README.md).

## Objective

A developer marks a tool as a job, for example `reschedule`, `send_email`, `delete_branch` or
`refund`, and returns plans instead of acting. From then on:

- **Within the person's policy**, the call runs the safest plan and returns a receipt.
- **Outside it**, the same call pauses, shows the person the plans, and runs the one they pick
  and confirm.
- **When the client can't ask**, nothing outside the policy runs until the person approves it
  somewhere else.
- **Afterwards**, anything reversible can be undone within its window.

The model can never approve anything on the person's behalf, and a replayed or stale approval
never runs anything.

**Approval is about what an action does, not only what it costs.** A plan is judged on which
tool it belongs to, how risky it is, and whether it can be undone. Money is one more check that
applies only to plans that declare a cost, and most jobs (sending an email, moving a meeting,
deleting a branch) have none.

**Users.** Server authors adopting YEA one tool at a time, and the people whose agents call
those servers.

## How a job call runs

Terms: a **plan** is the existing `Plan` (`summary`, `effects`, `cost`, `risk`, `apply()`,
optional `revert()` and `undoWindow`). `cost` is optional. The **policy** is the person's
standing rules. The **store** holds consumed approvals, receipts and the usage ledger.

```
call delete_branch({repo: "site", branch: "old-nav"})
  │
  ├─ preview: true ─────────────────────────────▶ plans as text; nothing runs, nothing stored
  │
  ├─ plans = handler(input)             (or a clarification: returned as is)
  │
  ├─ policy allows plans[0]? ── yes ───────────▶ apply, record receipt + ledger, return receipt
  │        │ no
  │        ▼
  ├─ client can elicit (form)? ── no ──────────▶ fail closed: plans + approval code (see below)
  │        │ yes
  │        ▼
  └─ return input_required: approval form + sealed state
        │
        retry with the person's answer
        │
        ├─ state invalid, expired or already used ▶ refuse, nothing runs
        ├─ declined or cancelled ─────────────────▶ "not approved", nothing runs
        ├─ confirmation wrong ────────────────────▶ ask again (up to 3 rounds)
        ├─ plans recomputed; chosen hash gone ────▶ ask again with the new plans
        └─ consume approval, apply, record receipt + ledger, return receipt
```

### 1. Plan hash

Approval binds to a **plan hash** that stays the same when the same plan is recomputed:

```
planHash = sha256(canonical({ tool, input, summary, effects, cost, risk, undoWindow }))
```

It leaves out volatile fields (proposal ids, expiry, `data`), unlike today's `proposalHash`.
`input` is the tool's validated input, so an approval to delete `old-nav` can't delete `main`.

### 2. Policy

The person's standing rules. By default nothing runs without asking, and plans at `high` risk
need out-of-band approval.

```ts
policy: {
  can: ['reschedule', 'delete_branch'], // tools that may run without asking at all
  maxRisk: 'low',                       // plans above this ask
  outOfBand: 'high',                    // plans at this risk need approval outside the chat (default)
  deny: ['delete_customer'],            // never runs, even with approval
  // Checked only for plans that declare a cost:
  perAction: money(25),                 // any single plan costing more asks
  total: { limit: money(100), per: '30d' },  // auto-run spend in the window
}
```

A plan runs without asking only when it passes every rule that applies to it: its tool is in
`can`, its risk is at most `maxRisk`, **it can be undone**, and, if it has a cost, the cost
fits `perAction` and `total`. A policy of `can: ['reschedule']` and `maxRisk: 'low'` lets an
agent move meetings on its own and asks about everything else, with no money involved.

**Only undoable plans run without asking.** This is the protocol's rule (SPEC.md §4.3.1, "if,
and only if" the proposal is undoable), and the framework can't be looser than the protocol.
So `send_email` always asks, while `delete_branch` can auto-run if its `revert()` restores
the branch at its old commit. Letting a signed grant allow irreversible auto-runs would be a
protocol change; see open question 7.

**What `can` matches.** A pattern matches the MCP tool's registered name, exactly or as a
prefix ending in `*`, the same rule as the grant `can` caveat. `delete_*` matches
`delete_branch`; `calendar*` also matches `calendarx`, so end prefixes with a separator.
Names aren't unique across servers: what scopes a grant to one server is its audience, the
server's own key (below).

The policy decides **only what runs without asking**. Anything the server offers, except what
`deny` lists, can still run with explicit approval. Only `plans[0]` is ever auto-run, so
authors list the safest common choice first, as the service-design guide already says.

**Anything that loosens the policy must be signed by the person.** An agent that can write
files (Claude Code can) must not be able to raise its own limits. So:

- A policy that auto-runs anything is a **grant signed with the principal key**. `yea grant`
  already issues these, and the caveats map one to one: `can`, `risk`, `per`, `spend`, `exp`.
  The
  server verifies it against the principal's public key, which the server author configures.
  MCP callers have no YEA key of their own, so grants and consents are issued **to the
  server's own key**, which the plugin generates on first run. The existing holder and proof
  checks then run unchanged, and a grant copied from another server doesn't work here.
- An unsigned policy, from server options or `~/.yea/policy.json`, **may only tighten** the
  defaults: add to `deny`, or lower `outOfBand` to `medium` or `low`. It can never auto-run anything.
- **Unsigned rules are best effort.** An agent that can write `~/.yea` can also delete a `deny`
  entry it doesn't like. Deleting the file only returns the server to its defaults, so the
  guaranteed floor is: nothing auto-runs without a signed grant, irreversible plans never
  auto-run, and `high` risk goes out of band. Rules above that floor hold only as long as the
  file does. Signed tightening rules would need new caveats; see open question 6.

Where the principal key lives decides how strong this is. If it sits in `~/.yea` on the
machine the agent runs on, an agent with shell access can sign for itself. The
`YEA_PRINCIPAL_HOME` option and its caveat carry over from the security guide unchanged: keep
the key on another account or device for real protection.

### 3. Asking: the approval form

The request is a form-mode elicitation. Forms allow only flat fields, so:

- `message`: the plans in Lens (effects, cost if any, risk, undo window), plus why approval is
  needed: "`send_email` can't be undone", "risk is high, and your limit is low", or
  "cost 71.36 USD is over your 25.00 USD per-action limit".
- `plan`: a single-select enum. Each option's value is the plan hash and its title is the
  plan's summary (`oneOf` of `const` and `title`). It's omitted when there's one plan.
- `confirm`: a required string. The person types **the thing that matters most** about the
  chosen plan, which makes them read it. A tool can name that phrase for each plan
  (`confirmWith(plan, input): string | Money`), the way GitHub asks you to type a
  repository's name before deleting it: the branch name, the recipient, the amount. If the
  tool doesn't, the default is the plan's cost when it has one, and `approve` otherwise. The
  field's description shows the exact phrase to type; with several plans, the message names
  each plan's phrase next to it.

An accepted form counts as approval **only** when `confirm` matches:

- **Text phrases**: both sides are NFC-normalized, stripped of leading and trailing
  whitespace (U+0009 to U+000D, U+0020, U+00A0, U+FEFF, a set both languages strip the same
  way), then lowercased with `toLowerCase()` / `str.lower()`. Not `casefold()`, which has no
  JavaScript equivalent.
- **Money phrases**: compare as numbers, and the currency code is optional: `22.87`, `22.870`
  and `22.87 USD` all match 22.87 USD. A different currency code doesn't match.

A tool must derive its phrase from the plan or the input, which the plan hash covers. Both
rules, including the whitespace and Unicode edge cases, are pinned in the conformance cases.
A bare accept or an empty form never counts: some clients auto-accept forms that
have no fields. This proves the form was filled in, not that a person read it. That is the
level form mode can give. Plans at or above `policy.outOfBand` skip the form and go straight
to out-of-band approval.

### 4. The state that goes round the client

The `input_required` result carries a `requestState`. Its plaintext is:

```json
{ "v": 1, "tool": "refund", "inputHash": "…", "plans": ["<planHash>", "…"], "nonce": "…", "exp": 1790000000 }
```

- **Sealing.** In Python, the SDK seals it (AES-256-GCM). In TypeScript, the plugin must
  install `createRequestStateCodec` (HMAC-SHA256). That codec **signs but doesn't encrypt**,
  so the plaintext must never hold secrets or personal data. Hashes and a nonce only.
- **Binding.** Bind to the tool name and, when the transport has one, the authenticated
  principal (`authInfo.clientId` or subject). Over stdio there is one user per process.
- **Keys.** Each process gets a random key, which is only safe while one process handles every
  round. Multi-process HTTP servers must pass a shared key.
- **Lifetime.** 10 minutes by default. Our `exp` must be no later than the SDK's own state
  lifetime.
- **Nesting.** A job tool may also ask its own questions. Our state wraps the tool's own as
  `{ "yea": {…}, "inner": "<the tool's requestState>" }`, and each side reads only its own
  half.
- **Per-language mechanics.** This spec defines the logical round and the plaintext. How each
  SDK carries it across protocol eras belongs to `mcp-ts` and `mcp-py`:
  - The TypeScript v2 legacy shim re-runs the handler for 2025-era clients.
  - Python doesn't shim a raw `InputRequiredResult`, and its `Resolve`/`Elicit` helpers own
    `requestState`, so they can't carry our nonce. `mcp-py` returns a raw
    `InputRequiredResult` on 2026-07-28 and falls back to an in-call `ctx.elicit` on 2025-era
    clients.

### 5. Checking the answer

On retry:

1. Verify the state. A failure, whatever the reason, refuses the call with the same message.
2. Read the answer with the SDK's schema-aware helper. A decline or cancel returns "not
   approved". A wrong `confirm` asks again.
3. **Recompute the plans** and find the one whose `planHash` matches the choice. If it's gone,
   ask again and say the plans changed.
4. **Consume the nonce** with `store.consumeOnce(nonce, exp)`, which is atomic. If it was
   already consumed, refuse the call. Resending the same approved call never runs twice.
5. Apply, then record the receipt. If `apply()` fails after the approval was consumed, the
   result says so plainly ("approved, but deleting `old-nav` failed: …; nothing changed"). The
   approval isn't reusable, so a retry asks again.

**Totals are reserved, not added afterwards.** This applies only to plans with a cost when the
policy has a `total`. Auto-runs call `store.reserve(principal, limit, amount, window)`
**before** `apply()`, which fails if the reservation would pass the limit. Then they `settle`
on success or `release` on failure. Two concurrent calls can't overshoot the limit, and a crash
never under-counts. The SDK core already reserves spend this way for grants. Explicitly
approved plans are written with `store.record(...)`, which never fails, into the same ledger:
the auto-run total sees them, but the limit never blocks them, since the person approved them
knowing what they do.

The ledger counts **integers** under a named limit: money in minor units, as on the wire
(`spend:USD` holds cents), so sums never drift and both languages agree exactly. A later count
limit ("at most 20 emails a day") needs no store change. Currencies are never converted: a
plan costing EUR checked against a USD `perAction` or `total` asks, as the grant checks already
fail closed on a currency mismatch. `Usage` is what `decide` reads: a map from limit name to
the amount used in its window.

### 6. When the client can't ask

Claude Desktop, claude.ai and Gemini CLI can't elicit today. A job outside the policy then
returns an error result with:

- the plans in Lens,
- a one-time **approval code** that encodes the tool, the input hash and the plan hash, and
- the line: *Ask the user to run `yea approve <code>` in their terminal, then call again.*

`yea approve` shows the plan, asks the person to confirm, and writes a **consent signed with
the principal key**. This is the existing `pc1.` consent grant, bound to the plan hash. On the
next identical call, the server recomputes the plans, verifies the signature against the
principal's public key, and checks that the consent's plan hash is still offered. If it is,
the server consumes the consent and runs the plan. If not, it issues a fresh code. The
consent's own expiry bounds how long a code stays usable. An unsigned approval in the store is never accepted,
so an agent that writes files or runs commands can't approve for the person. The key-location
caveat in section 2 applies here too.

v0 supports this where the server and the `yea` command share a store (a local stdio server).
For remote HTTP servers, url-mode approval pages come later.

### 7. Undo

`undo({ receipt })` looks up the receipt. It runs only within the plan's undo window, only for
the same principal, and only once. It calls `revert()` and records that the action was undone.
Undo needs no approval, because it restores what the person already approved changing. An
irreversible plan's receipt says `undo: never`, and undo refuses it with that reason.

### 8. The store

```ts
interface ApprovalStore {
  consumeOnce(nonce: string, expiresAt: number): Promise<boolean>;  // true the first time only
  putReceipt(r: Receipt): Promise<void>;
  getReceipt(id: string): Promise<Receipt | null>;
  markUndone(id: string): Promise<boolean>;                          // true the first time only
  reserve(principal: string, limit: string, amount: number, max: number, window: string): Promise<Reservation | null>; // null: over max
  record(principal: string, limit: string, amount: number, window: string): Promise<void>;   // approved plans; never refuses
  usage(principal: string, window: string): Promise<Usage>;          // limit name → integer used
  settle(r: Reservation): Promise<void>;
  release(r: Reservation): Promise<void>;
  pendingConsent(code: string): Promise<string | null>;              // a signed pc1. token from `yea approve`
}
```

`FileStore`'s on-disk format is pinned in this spec's conformance cases. That way the
TypeScript and Python servers and the `yea` command can share one store. `consumeOnce` and
`markUndone` create a marker file with `O_EXCL`, so they are atomic across processes.

Implementations:

- `MemoryStore` is the default, for a single process.
- `FileStore` lives under `~/.yea`. Local stdio servers share it with the `yea` command.
- A custom store (Redis, SQL) is for multi-process servers.

**Fail closed.** An HTTP server with a `total` limit on the default memory store refuses to start
unless the author passes `store` or sets `singleProcess: true`.

## Mapping to the protocol

| MCP framework | YEA protocol (SPEC.md) |
|---|---|
| Job tool call | `INTENT` with `auto`, then `COMMIT` of `plans[0]` |
| `preview: true` | `INTENT` without commit |
| Approval form and typed confirmation | Consent bound to a plan (the `pc1.` consent grant's role) |
| `yea approve <code>` | A `pc1.` consent grant signed by the principal |
| Policy | A grant signed by the principal (its caveats); unsigned config can only tighten it |
| `undo(receipt)` | `UNDO` |

The wire protocol doesn't change. Whether SPEC.md gets an "MCP binding" section is an open
question.

## Where the code lives

```
ts/src/approval.ts        plan hash, policy decision, form builder, state payload, answer check
ts/src/store.ts           ApprovalStore, MemoryStore, FileStore
ts/test/approval.test.ts  unit tests + the shared conformance cases
python/src/yea/approval.py, store.py, python/tests/test_approval.py   the same, for Python
conformance/approval.json shared cases, generated from the TS reference (like the other vectors)
```

The SDK core stays zero-dependency. The MCP SDKs are peer dependencies of `mcp-ts` and
`mcp-py` only.

## Code style

As in the rest of the repo: `npm run lint && npm run lint:style` (Biome and oxlint) for
TypeScript, and small named functions that don't use `any` or `!`. For example:

```ts
/** What a job call should do with these plans under this policy. */
export function decide(plans: Plan[], policy: Policy, usage: Usage): Decision {
  if (plans.length === 0) {
    return { kind: 'nothing' };
  }

  const first = plans[0];
  const why = needsApproval(first, policy, usage);

  if (why === null) {
    return { kind: 'run', plan: first };
  }

  return atLeast(first.risk, policy.outOfBand)
    ? { kind: 'out-of-band', why }
    : { kind: 'ask', why };
}
```

## Testing

- **Conformance cases** (`conformance/approval.json`). Given plans, a policy and a ledger, both
  languages agree on:
  - the decision, and the reason text;
  - the plan hashes;
  - the form schema;
  - the state plaintext;
  - how every answer is judged: accept, decline, cancel, wrong confirmation, unknown plan,
    replay, and plans that changed;
  - the `FileStore` on-disk format.
- **Unit tests** for the store: consume-once under concurrent calls, undo once, and
  reservations under concurrency and failure.
- **Security tests** in `ts/test/security.test.ts` and its Python counterpart: an unsigned
  approval is rejected; an unsigned policy can't loosen the defaults; a consent for one plan
  can't run another; a replayed state or consent runs nothing; an irreversible plan never
  auto-runs, whatever the grant says; deleting the unsigned policy file returns to the
  defaults, never to something looser.
- **End-to-end tests** live in `mcp-ts` and `mcp-py`, with in-memory MCP clients: 2026-era,
  2025-era (TypeScript through the SDK's legacy shim, Python through an in-call `ctx.elicit`),
  and no elicitation.

## Boundaries

- **Always:** fail closed; bind approval to the plan hash and the input; consume approvals
  once; keep secrets out of `requestState`; keep the SDK core zero-dependency; ship TypeScript
  and Python together.
- **Ask first:** changing SPEC.md or the wire format; storing anything beyond hashes in the
  state; changing a default in a way that runs more without asking.
- **Never:** treat a bare accept as approval; let the model approve; accept an unsigned
  approval, or an unsigned policy that loosens the defaults; use sampling; auto-run anything
  but `plans[0]`.

## Success criteria

- Both languages pass `conformance/approval.json`.
- A resent approved call runs once. A call whose plans changed asks again. A wrong
  confirmation asks again, and three wrong ones refuse the call.
- Over the same policy, a job either runs, asks, or fails closed with an approval code, and
  never does anything else.
- `undo` works once within the window, and never outside it or for another principal.
- An unsigned approval, or an unsigned policy that would loosen the defaults, is rejected.
  Only the principal's signature can make something run without the form.
- A policy with no money rules (`can`, `maxRisk`) works for tools that have no
  cost, and a plan with no cost is never checked against `perAction` or `total`.
- Concurrent auto-runs never go past a `total` limit, and a failed `apply()` releases its
  reservation.
- An HTTP server with a `total` limit and the default store refuses to start.

## Open questions

Proposed answers are marked. parley-05's review agreed with 1 and 3 to 5. Question 2 changed
when approval stopped being about money; 6 and 7 are new, and 7 is the real decision.

1. **Does explicit approval go past the limits?** Proposed: yes, since limits only govern what
   runs without asking. `deny` covers things that must never run.
2. **What does the person type?** Proposed: a phrase the tool names for each plan (the
   branch name, the recipient, the amount). By default, the plan's cost when it has one,
   otherwise `approve`.
3. **Remote servers.** Proposed: local, signed `yea approve` is enough for v0, and url-mode
   pages come later.
4. **Should undo ask?** Proposed: no, within the window.
5. **Should SPEC.md get an "MCP binding" appendix?** Proposed: after v0 ships.
6. **Signed tightening and count limits.** Should `deny`, `outOfBand` and count limits ("at
   most 20 emails a day") also be caveats in the signed grant, so an agent can't delete them?
   The server would take the union of signed and unsigned rules. Proposed: after v0. It needs
   new caveats in SPEC.md; until then, unsigned rules are best effort above a fixed floor (§2).
7. **Can anything irreversible run without asking?** Proposed: no, for v0. Only undoable plans
   auto-run, as SPEC.md §4.3.1 already requires, so `send_email` and most refunds always ask.
   The alternative is a new grant caveat that lets the person allow named irreversible tools
   to auto-run. That's a protocol change (SPEC.md, vectors, TypeScript and Python), and
   allowing it would always need a signature.
