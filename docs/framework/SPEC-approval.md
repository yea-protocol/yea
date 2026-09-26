# Spec: approval

The approval contract for YEA's framework plugins. It decides when a job tool's plan runs on
its own, when a person must approve it, how that approval is asked for and checked, and how
an action is undone. `mcp-ts` and `mcp-py` implement the MCP side of it. The logic itself lives
in the SDK core of both languages and passes shared conformance cases.

Issue: [#37](https://github.com/yea-protocol/yea/issues/37). Map: [README.md](README.md).

## Objective

A developer marks a tool as a job, for example `refund`, and returns plans instead of acting.
From then on:

- **Within the person's policy**, the call runs the safest plan and returns a receipt.
- **Outside it**, the same call pauses, shows the person the plans, and runs the one they pick
  and confirm.
- **When the client can't ask**, nothing outside the policy runs until the person approves it
  somewhere else.
- **Afterwards**, anything reversible can be undone within its window.

The model can never approve anything on the person's behalf, and a replayed or stale approval
never runs anything.

**Users.** Server authors adopting YEA one tool at a time, and the people whose agents call
those servers.

## How a job call runs

Terms: a **plan** is the existing `Plan` (`summary`, `effects`, `cost`, `risk`, `apply()`,
optional `revert()` and `undoWindow`). The **policy** is the person's standing rules. The
**store** holds consumed approvals, receipts and the spend ledger.

```
call refund({who: "Chen"})
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
`input` is the tool's validated input, so an approval for Chen's refund can't run Ana's.

### 2. Policy

The person's standing rules. The default is empty, so every job asks.

```ts
policy: {
  maxRisk: 'low',                       // plans above this ask
  perAction: money(25),                 // any single plan costing more asks
  total: { limit: money(100), per: '30d' },  // auto-run spend in the window
  requireUndo: true,                    // irreversible plans ask
  outOfBand: 'high',                    // plans at this risk need approval outside the chat
  deny: ['billing.delete_customer'],    // never runs, even with approval
}
```

The policy decides **only what runs without asking**. Anything the server offers, except what
`deny` lists, can still run with explicit approval. Only `plans[0]` is ever auto-run, so
authors list the safest common choice first, as the service-design guide already says.

**Anything that loosens the policy must be signed by the person.** An agent that can write
files (Claude Code can) must not be able to raise its own limits. So:

- A policy that auto-runs anything is a **grant signed with the principal key**. `yea grant`
  already issues these, and the caveats map one to one: `risk`, `per`, `spend`, `exp`. The
  server verifies it against the principal's public key, which the server author configures.
  MCP callers have no YEA key of their own, so grants and consents are issued **to the
  server's own key**, which the plugin generates on first run. The existing holder and proof
  checks then run unchanged, and a grant copied from another server doesn't work here.
- An unsigned policy, from server options or `~/.yea/policy.json`, **may only tighten** the
  defaults: add to `deny`, or require out-of-band approval. It can never auto-run anything.

Where the principal key lives decides how strong this is. If it sits in `~/.yea` on the
machine the agent runs on, an agent with shell access can sign for itself. The
`YEA_PRINCIPAL_HOME` option and its caveat carry over from the security guide unchanged: keep
the key on another account or device for real protection.

### 3. Asking: the approval form

The request is a form-mode elicitation. Forms allow only flat fields, so:

- `message`: the plans in Lens (effects, cost, risk, undo window), plus why approval is needed
  ("cost 71.36 USD is over your 25.00 USD per-action limit").
- `plan`: a single-select enum. Each option's value is the plan hash and its title is the
  plan's summary (`oneOf` of `const` and `title`). It's omitted when there's one plan.
- `confirm`: a required string. The person types the chosen plan's cost as shown (`22.87`),
  or `approve` when the plan costs nothing. Typing the amount makes the person read it.

An accepted form counts as approval **only** when `confirm` matches. Amounts compare as
numbers, and the currency code is optional: `22.87`, `22.870` and `22.87 USD` all match
22.87 USD. `approve` compares after trimming and lowercasing. Both rules are pinned in the
conformance cases. A bare accept or an empty form never counts: some clients auto-accept forms that
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
   result says so plainly ("approved, but the refund failed: …; nothing was charged"). The
   approval isn't reusable, so a retry asks again.

**Spend is reserved, not added afterwards.** Auto-runs call `store.reserveSpend(principal,
cost, window)` **before** `apply()`, which fails if the reservation would pass the cap. Then
they `settle` on success or `release` on failure. Two concurrent calls can't overshoot the
cap, and a crash never under-counts. The SDK core already reserves spend this way for grants.
Explicitly approved spend is recorded in the same ledger, so the auto-run budget sees it, but
the cap never blocks it: the person approved it knowing the cost.

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
  reserveSpend(principal: string, amount: Money, window: string): Promise<Reservation | null>; // null: over the cap
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

**Fail closed.** An HTTP server with a spend cap on the default memory store refuses to start
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
export function decide(plans: Plan[], policy: Policy, spent: Money): Decision {
  if (plans.length === 0) {
    return { kind: 'nothing' };
  }

  const first = plans[0];
  const why = needsApproval(first, policy, spent);

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
- **Unit tests** for the store: consume-once under concurrent calls, undo once, and spend
  reservations under concurrency and failure.
- **Security tests** in `ts/test/security.test.ts` and its Python counterpart: an unsigned
  approval is rejected; an unsigned policy can't loosen the defaults; a consent for one plan
  can't run another; a replayed state or consent runs nothing.
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
- Concurrent auto-runs never spend past the cap, and a failed `apply()` releases its
  reservation.
- An HTTP server with a spend cap and the default store refuses to start.

## Open questions

Proposed answers are marked. parley-05's review agrees with each.

1. **Does explicit approval go past the caps?** Proposed: yes, since caps only govern what
   runs without asking. `deny` covers things that must never run.
2. **What does the person type?** Proposed: the plan's cost when it has one, otherwise
   `approve`.
3. **Remote servers.** Proposed: local, signed `yea approve` is enough for v0, and url-mode
   pages come later.
4. **Should undo ask?** Proposed: no, within the window.
5. **Should SPEC.md get an "MCP binding" appendix?** Proposed: after v0 ships.
