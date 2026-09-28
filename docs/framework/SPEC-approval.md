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

The model can't approve anything on the person's behalf, and a replayed or stale approval
never runs anything. Both hold only as far as the principal key, the principal's public key
and the store are out of the agent's reach (§9).

**Approval is about what an action does.** A plan is judged on which tool it belongs to, how
risky it is, whether it can be undone, and what it uses up. What it uses is the protocol's
generic `uses` (SPEC.md §5.1): money, emails, deletions, anything the tool reports. Most jobs
(moving a meeting, deleting a branch) use nothing that's limited.

**Users.** Server authors adopting YEA one tool at a time, and the people whose agents call
those servers.

## How a job call runs

Terms:
- A **plan** is the existing `Plan`: `summary`, `effects`, `uses?`, `risk?`, `undoWindow?`
  and `apply()`. A plan's `risk` defaults to the tool's declared risk, else `medium`. Any
  risk other than `low`, `medium` or `high` is malformed: that plan never gets a plan hash, and
  the call is refused. Wherever a risk is compared anyway, an unknown one fails closed: it
  counts as riskier than `high`, so it passes no `risk` ceiling and always goes out of band.
- The **policy** is the person's standing rules (§2).
- The **store** holds consumed approvals, receipts and the usage ledger (§8).

The tool's handler only computes plans. It MUST NOT change anything, because it runs again on
preview, on every retry, and under the TypeScript legacy shim (as SPEC.md §4.3 requires of
`INTENT`).

```
call delete_branch({repo: "site", branch: "old-nav"})
  │
  ├─ tool in deny? ─────────────────────────────▶ refuse, nothing runs (not even a preview)
  │
  ├─ preview: true ─────────────────────────────▶ plans as text; nothing runs, nothing stored
  │
  ├─ plans = handler(input)             (or a clarification: returned as is)
  │
  ├─ policy allows plans[0]? ── yes ─ reserve ─▶ apply, record receipt, return receipt
  │        │ no                     (fails: ask)
  │        ▼
  ├─ client can elicit (form)? ── no ──────────▶ fail closed: plans + consent codes (§6)
  │        │ yes
  │        ▼
  └─ return input_required: approval form + sealed state
        │
        retry with the person's answer
        │
        ├─ state invalid, expired, used, or for other input ▶ refuse, nothing runs
        ├─ consume the nonce (every retry)
        ├─ declined or cancelled ─────────────────▶ "not approved", nothing runs
        ├─ plans recomputed; chosen hash gone ────▶ ask again with the new plans
        ├─ chosen plan at or above outOfBand ─────▶ fail closed with a consent code (§6)
        ├─ confirmation wrong ────────────────────▶ ask again (3 rounds in all)
        └─ apply, record receipt, return receipt
```

Each call is a new request. MCP has no frame id to deduplicate on, so a client that resends an
auto-run call runs it again, as it would any MCP tool. Tools that must not repeat should be
idempotent themselves (the Stripe example passes an idempotency key).

### 1. Plan hash

Approval binds to a **plan hash** that stays the same when the same plan is recomputed:

```
planHash = b64url(sha256(canonical({ tool, input, summary, effects, uses, risk, undoWindow })))
```

- `b64url` and `canonical` are SPEC.md's (§6.1, §10). Absent optional fields are left out,
  and so is an empty `uses`, which means the same as an absent one (SPEC.md §5.1).
- It leaves out volatile fields (proposal ids, expiry, `data`), unlike today's `proposalHash`.
- `input` is the tool's validated input, so an approval to delete `old-nav` can't delete
  `main`.
- Canonical JSON allows only integers, so a job tool's input MUST NOT contain other numbers.
  A call whose input has one fails closed with an error that tells the author to use a string
  or an integer instead.

### 2. Policy

The person's standing rules come in two parts.

**The signed part** is a grant signed with the principal key (`yea grant` issues it). Its
caveats are the protocol's own, and only it can make anything run without asking:

```ts
// caveats of the signed policy grant
[
  { can: ['reschedule', 'delete_branch'] },               // tools that may run without asking
  { risk: 'low' },                                         // plans above this ask
  { each: { of: 'spend', max: 2500, scale: 2, unit: 'USD' } }, // any single plan using more asks
  { total: { of: 'emails', max: 20 } },                    // for the grant's lifetime
  { exp: 1790000000 },                                     // the policy ends
]
```

**The unsigned part**, from server options or `~/.yea/policy.json`, can only tighten:

```json
{ "deny": ["delete_customer"], "outOfBand": "medium" }
```

A tool in `deny` never runs: the call is refused before anything else, with or without
approval, on every path (auto-run, the form, and `yea approve`).

A plan runs without asking only when **all** of these hold:

1. a valid signed policy authorizes a `COMMIT` of the tool at this server: it has a `can`
   caveat, which covers the tool name (a grant with no `can` covers every tool, so a policy
   must name its tools), its `svc` (if any) includes the server's service id, its `verbs` (if
   any) include `COMMIT`, and it hasn't expired at the time of the call;
2. its risk is at most the `risk` caveat, and below `outOfBand` (default `high`);
3. **it can be undone**: it has an `undoWindow` and the tool has `revert` (§7);
4. what it `uses` fits every `each` and `total` limit, by SPEC.md §6.3's rules (units match
   exactly, values compare exactly, a plan that doesn't report a measure passes).

A policy of `can: ['reschedule']` and `risk: 'low'` lets an agent move meetings on its own and
asks about everything else. A `total` runs for the grant's lifetime, not a rolling window: for
"20 emails a day", issue a grant that expires in a day.

**Only undoable plans run without asking.** This is the protocol's rule (SPEC.md §4.3.1, "if,
and only if" the proposal is undoable), and the framework can't be looser than the protocol.
So `send_email` always asks, while `delete_branch` can auto-run if its `revert` restores the
branch at its old commit. Allowing irreversible auto-runs would be a protocol change (decision
7).

**What `can` matches.** A pattern matches the MCP tool's registered name, exactly or as a
prefix ending in `*`, the same rule as the grant `can` caveat. `delete_*` matches
`delete_branch`; `calendar*` also matches `calendarx`, so end prefixes with a separator.

The policy decides **only what runs without asking**. Anything the server offers, except what
`deny` lists, can still run with explicit approval. Only `plans[0]` is ever auto-run, so
authors list the safest common choice first, as the service-design guide already says.

**Verifying the signed part.**
- The server has its own Ed25519 key, generated by the plugin on first run. Its public key is
  also the server's **service id**, the value `svc` caveats name. MCP callers have no YEA key
  of their own, so policy grants and consent grants are issued **to the server's key**, and
  the server checks them as a COMMIT of the tool (SPEC.md §6.3), against the pinned principal
  key. The existing holder and proof checks then run
  unchanged, and a grant copied from another server doesn't work here.
- The principal's public key is pinned by **the person**, in a file the agent can't change:
  `YEA_PRINCIPAL_PUB` names it. The plugin refuses the key unless neither the file nor any
  directory above it is owned by, or writable by, the server's OS user (an owner could
  `chmod` it back, and a writable directory lets the file be replaced). A key read from
  `~/.yea` or from an MCP config the agent can edit (`.mcp.json`) proves nothing, because the
  agent could swap in its own key.

**Reading the unsigned part.** Unknown fields and anything that would loosen (removing a
default, raising `outOfBand` above `high`) are ignored with a warning on stderr, and the valid
tightenings still apply. A file that isn't valid JSON is ignored the same way.

**The floor.** Unsigned rules are best effort: an agent that can write `~/.yea` can delete a
`deny` entry. Deleting the file only returns the server to its defaults. So what holds without
any file is: nothing auto-runs without a signed grant, irreversible plans never auto-run, and
`high` risk always goes out of band. Signed `deny` and `outOfBand` would need new caveats
(decision 6).

### 3. Asking: the approval form

The request is a form-mode elicitation. Forms allow only flat fields, so:

- `message`: the plans in Lens (effects, uses, risk, undo window), plus why approval is
  needed: "`send_email` can't be undone", "risk is high, and your limit is low", or the
  protocol's limit reason, "spend over the per-commit limit of 25.00 USD".
- `plan`: a single-select enum. Each option's value is the plan hash and its title is the
  plan's summary (`oneOf` of `const` and `title`). It's omitted when there's one plan. Plans
  at or above `outOfBand` are listed in the message but left out of the enum, with a note that
  they need out-of-band approval.
- `confirm`: a required string. The person types **the phrase for the chosen plan**, which
  makes them read it. A tool can name a phrase for each plan with
  `confirmWith(plan, input): string`, the way GitHub asks you to type a repository's name
  before deleting it: the branch name, the recipient, the amount as written in the summary.
  If the tool names none, or names one that is empty once normalized, the phrase is
  `approve`. The field's description shows the exact phrase; with several plans, the message
  names each plan's phrase next to it. Denied plans are listed apart as never allowed, and
  when no plan can be offered at all, there is no form: the call fails closed with consent
  codes (§6).

An accepted form counts as approval **only** when `confirm` matches the phrase: both sides are
NFC-normalized, then stripped of leading and trailing characters in **exactly** this set:
U+0009 to U+000D, U+0020, U+00A0 and U+FEFF (not `trim()` or `strip()`, which strip different
sets), then lowercased with `toLowerCase()` / `str.lower()` (not `casefold()`, which has no
JavaScript equivalent). A tool must derive its phrase from the plan or the input, which the
plan hash covers. The rule and its edge cases are pinned in the conformance cases.

A bare accept or an empty form never counts: some clients auto-accept forms that have no
fields. This proves the form was filled in, not that a person read it. That is the level form
mode can give.

### 4. The state that goes round the client

The `input_required` result carries a `requestState`. Its plaintext is:

```json
{ "v": 1, "tool": "delete_branch", "inputHash": "…", "sub": "…", "plans": ["<planHash>", "…"],
  "round": 1, "nonce": "…", "exp": 1790000000 }
```

- `inputHash` is `b64url(sha256(canonical(input)))`. `sub` is the authenticated principal
  (`authInfo.clientId` or subject) when the transport has one, and `""` over stdio, where
  there is one user per process. `round` counts the forms shown for this call, from 1.
- **Sealing.** In Python, the SDK seals it (AES-256-GCM). In TypeScript, the plugin must
  install `createRequestStateCodec` (HMAC-SHA256). That codec **signs but doesn't encrypt**,
  so the plaintext must never hold secrets or personal data: hashes, a counter and a nonce
  only.
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
    `InputRequiredResult` on 2026-07-28 and falls back to an in-call `session.elicit_form` on
    2025-era clients, which takes the form's raw schema (see SPEC-mcp-py).

### 5. Checking the answer

On retry:

1. **Verify the state**: its seal, `exp`, `tool`, `sub`, and that `inputHash` matches the
   retried call's input. Any failure refuses the call with the same message.
2. **Consume the nonce** with `store.consumeOnce(nonce, exp)`, which is atomic. If it was
   already consumed, refuse the call. Every retry consumes its nonce, whatever the answer,
   and every form asked again carries a fresh nonce and `round + 1`. So resending an old
   state never runs twice and never buys more rounds.
3. **Read the answer** with the SDK's schema-aware helper. A decline or cancel returns "not
   approved".
4. **Recompute the plans** and find the one whose `planHash` matches the choice. If it's gone,
   ask again and say the plans changed.
5. **Check the chosen plan**: if its tool is denied, refuse; if its risk is at or above
   `outOfBand`, fail closed with a consent code (§6).
6. **Check the phrase** against the chosen plan's (§3). If it's wrong, ask again.
7. Asking again past round 3, for any reason, refuses the call instead.
8. **Apply**, then record the receipt. If `apply()` fails after the approval was consumed, the
   result says so plainly ("approved, but deleting `old-nav` failed: …; nothing changed"). The
   approval isn't reusable, so a retry asks again.

**Totals are reserved, not added afterwards.** An auto-run whose plan reports a measure that a
`total` limits calls `store.reserve(...)` **before** `apply()`, for every `total` in every
block of the policy grant. There is one reservation per block and measure; when a block
repeats a `total` on the same measure, the smallest `max` applies. Reservations are all or
nothing: if any would pass its limit, the ones already made are released and the call asks
instead of running. It `settle`s them all on success and `release`s them all on failure. Two concurrent calls can't overshoot a limit,
and a crash never under-counts.

**Explicitly approved plans don't count against the policy's totals**, as in the protocol: a
consented `COMMIT` is authorized by the consent grant, which has no `total` (SPEC.md §6.6).
Limits govern only what runs without asking (decision 1).

### 6. When the client can't ask

Claude Desktop, claude.ai and Gemini CLI can't elicit today. A job outside the policy, or a
chosen plan at or above `outOfBand`, then returns an error result with:

- the plans in Lens,
- a **consent code** for each plan that may be approved (not for denied tools), and
- the line: *Ask the user to run `yea approve <code>` in their terminal, then call again.*

The consent code is the existing unsigned `pc1.` code: SPEC.md's consent request, with the
plan's details. For a job, its fields are `proposal` and `hash` = the plan hash, `service` =
the server's service id, `capability` = the tool, `principal` = the pinned principal key,
`summary`, and `expires` = now + 10 minutes. Its `detail` is `{ job, phrase }`: `job` is the
full plan-hash preimage (`tool`, `input`, `summary`, `effects`, `uses`, `risk`,
`undoWindow`), and `phrase` is what the person types. Nothing outside `job` is trusted: the
phrase only checks that the person read the plan.

`yea approve <code>`:
1. recomputes the plan hash from the preimage, and refuses if it doesn't equal the code's
   `hash` and `proposal`, if the code's `capability` isn't the plan's `tool`, or if the code
   has expired; it caps `expires` at 10 minutes from now, whatever the code says;
2. shows the plan, never only a summary, in which control, format, line/paragraph-separator
   and invisible filler characters are shown as `\u{…}` escapes, so the text can't rewrite
   what the person reads;
3. asks the person to type the plan's phrase (§3), the same check as the form (an empty
   phrase falls back to `approve`);
4. signs a **consent grant** (`pg1.`) with the principal key, issued **to the server's key**,
   with `[{svc:[service]}, {verbs:["COMMIT"]}, {can:[tool]}, {only: planHash}, {exp}]`, and
   saves it in the store under the plan hash (`YEA_STORE`, else `~/.yea/store`).

On the next identical call, the server looks up a consent for each recomputed plan's hash
and checks it: it must be a single root block that itself carries `only` = that plan hash
and an `exp` (so neither a copied policy grant nor a block the server's key appended to one
ever counts), and pass the grant check as a `COMMIT` of the tool at this server, signed by
the pinned principal key (§2). It then consumes it with
`consumeOnce(<consent grant id>, exp)`, and runs that plan. Consents are keyed by plan hash,
not by code, so a fresh code for the same plan still finds them; a consumed or expired one
counts as absent, and the server issues fresh codes. Denied tools and plans that aren't
recomputed are never run. An unsigned approval in the store is never accepted.

This needs `yea approve` changes (today it issues to the agent key and checks
`proposalHash`), and a store shared by the server and the `yea` command: a local stdio server
with `FileStore`. For remote HTTP servers, url-mode approval pages come later.

### 7. Undo

A plan is undoable when it has an `undoWindow` and the tool defines
`revert({ input, planHash, result })`. `revert` is on the tool, not the plan, so a receipt can
be undone from any process: the receipt stores what it needs.

`undo({ receipt })` takes a receipt id from the caller, so it first checks the id against the
generated format (`r_` and 8 to 32 characters of `A-Z a-z 0-9 _ -`) and answers "not found"
otherwise; the id never reaches a file path unchecked. A receipt whose `service` isn't this
server's is "not found" too, since servers may share a store. It then runs only within the
undo window (through `until` itself, as the protocol's `UNDO` does), only for the same
principal (`sub`), and only once:

1. `store.claimUndo(id)` (atomic; false if already claimed or undone);
2. call the tool's `revert` with the stored input, plan hash and result;
3. on success, `store.markUndone(id)`; on failure, `store.releaseUndo(id)`, so it can be tried
   again.

Undo needs no approval, because it restores what the person already approved changing. An
irreversible plan's receipt says `undo: never`, and undo refuses it with that reason.

### 8. The store

```ts
interface ApprovalStore {
  consumeOnce(id: string, expiresAt: number): Promise<boolean>;    // true the first time only
  putReceipt(r: JobReceipt): Promise<void>;
  getReceipt(id: string): Promise<JobReceipt | null>;
  claimUndo(id: string): Promise<boolean>;                           // true the first time only
  releaseUndo(id: string): Promise<void>;
  markUndone(id: string): Promise<void>;
  reserve(k: LedgerKey, amount: bigint, max: bigint): Promise<Reservation | null>; // null: over max
  settle(r: Reservation): Promise<void>;
  release(r: Reservation): Promise<void>;
  used(k: LedgerKey): Promise<bigint>;                               // settled + reserved
  putConsent(planHash: string, grant: string): Promise<void>;        // from `yea approve`
  getConsent(planHash: string): Promise<string | null>;              // a signed pg1. consent grant
}

type LedgerKey = { block: string; of: string };  // a policy grant block id and a measure
type Reservation = { key: LedgerKey; amount: bigint; id: string };
type JobReceipt = Receipt & {                     // SPEC.md's receipt, plus what undo needs
  service: string; tool: string; input: unknown; planHash: string; sub: string;
};
```

Amounts are the SDK core's `exact()` values: integers at scale 18. What `decide` reads is
`used(k)`: the settled plus reserved amount for a block and measure.

**Store selection.** Stdio servers use `FileStore` by default, because `yea approve` and undo
across restarts need it. HTTP servers use `MemoryStore` by default, and one with a `total`
limit refuses to start on it unless the author passes `store` or sets `singleProcess: true`.
A custom store (Redis, SQL) is for multi-process servers.

**`FileStore` format**, under `~/.yea/store/` (or `YEA_HOME`), pinned by the conformance
cases so the TypeScript and Python servers and the `yea` command share one store:

```
consumed/<b64url(sha256(id))>        empty marker, created with O_EXCL; holds exp as text
undo/<receipt id>.claim, .done       markers, created with O_EXCL; the claim holds a random token and stays after done
receipts/<receipt id>.json           the JobReceipt as JSON (read, not byte-pinned: results may hold floats)
ledger/<block>/<of>.json             {"settled": "<decimal>", "reserved": {"<rid>": "<decimal>"}}
consents/<planHash>                  the pg1. consent grant (plan hashes are b64url)
```

Ledger files are `{"settled": "<decimal>", "reserved": {"<v_ id>": "<decimal>"}}`, updated under
an exclusive lock file (`<of>.lock` beside them, `O_EXCL`, retried every 10 ms for up to 2 s,
then a store error). The lock holds a random token: its holder re-checks the token before and
after writing, deletes the lock only if it still holds it, and reports a store error (nothing
runs) if the token changed. A lock older than 30 s is stale: a waiter reads its token, renames
it aside, and deletes it only if the moved file still holds that token; otherwise it links it
back. Undo claims hold a token too, and one older than 10 minutes with no `done` marker (the
process died) may be claimed again the same way. A holder paused for more than 30 s between
its checks is the one case lock files can't fully close; the check after writing turns it
into a store error instead of a silent overshoot. Files are written to a uniquely named temp file
(`<name>.<random>.tmp`) and renamed. Directories are created private (`0700`). Receipt ids
are `r_` and 12 b64url characters, reservation ids `v_` and 12. Expired markers may be
removed after `exp`.

## 9. Security

- **The key file check fails closed.** The plugin refuses the pinned key when it runs as root
  (root can write anything) and on platforms where it can't check file ownership.
- **Keep the agent away from three things.** The principal key (or it signs for itself), the
  pinned principal public key (or it swaps in its own), and the store (or it resets totals,
  deletes a `consumeOnce` marker to replay a consent within its `exp`, or deletes receipts).
  `YEA_PRINCIPAL_HOME`, the write check on `YEA_PRINCIPAL_PUB`, and running the server as
  another OS user are how. On one account with a shell-capable agent, the guarantees are best
  effort, as the security guide already says for the principal key.
- **A restarted server keeps its totals** only with a persistent store, which is why stdio
  defaults to `FileStore`.
- **Short consents.** Consent grants expire in 10 minutes by default, which bounds a replay
  if a marker is ever deleted.
- **Fail closed** everywhere: an invalid state, a missing or unsigned policy, an unpinned key,
  a non-integer input, or a store error all mean nothing runs.

## Mapping to the protocol

| MCP framework | YEA protocol (SPEC.md) |
|---|---|
| Job tool call | `INTENT` with `auto`, then `COMMIT` of `plans[0]` |
| `preview: true` | `INTENT` without commit |
| Approval form and typed confirmation | Consent bound to one plan (the role of a consent grant) |
| Consent code and `yea approve` | A `pc1.` consent request, then a `pg1.` consent grant signed by the principal |
| Signed policy | A grant signed by the principal, with its caveats; unsigned config can only tighten |
| `undo(receipt)` | `UNDO` |

The wire protocol doesn't change. SPEC.md gets an "MCP binding" section after v0 (decision 5).

## Where the code lives

```
ts/src/approval.ts        plan hash, policy decision, form builder, state payload, answer check
ts/src/store.ts           ApprovalStore, MemoryStore, FileStore
ts/src/cli.ts             yea approve for job consent codes
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
export function decide(
  plans: Plan[],
  policy: Policy,
  used: (k: LedgerKey) => bigint,
): Decision {
  if (plans.length === 0) {
    return { kind: 'nothing' };
  }

  const first = plans[0];

  if (policy.deny.includes(first.tool)) {
    return { kind: 'denied' };
  }

  if (atLeast(first.risk, policy.outOfBand)) {
    return { kind: 'out-of-band', why: outOfBandReason(first, policy) };
  }

  const why = needsApproval(first, policy, used);

  return why === null ? { kind: 'run', plan: first } : { kind: 'ask', why };
}
```

## Testing

- **Conformance cases** (`conformance/approval.json`). Given plans, a policy and a ledger, both
  languages agree on:
  - the decision, and the reason text;
  - the plan hashes, and the refusal of non-integer inputs;
  - the form schema, including plans left out for `outOfBand`;
  - the state plaintext;
  - how every answer is judged: accept, decline, cancel, a wrong confirmation (and three),
    an unknown plan, a replayed or resent state, other input, and plans that changed;
  - confirmation matching, with its whitespace and Unicode edge cases;
  - reading an unsigned policy file with loosening and unknown fields;
  - the `FileStore` on-disk format.
- **Unit tests** for the store: consume-once under concurrent calls, claim-undo once, and
  reservations under concurrency and failure.
- **Security tests** in `ts/test/security.test.ts` and its Python counterpart:
  - an unsigned approval is rejected, and an unsigned policy can't loosen the defaults;
  - a consent for one plan can't run another, and a replayed state or consent runs nothing;
  - an irreversible plan never auto-runs, whatever the grant says;
  - a `high` plan never auto-runs and can't be approved in the form, even as `plans[1]`;
  - a `deny`ed tool never runs, even with approval;
  - deleting the unsigned policy file returns to the defaults, never to something looser;
  - undo refuses outside its window, for another principal, a second time, for an id that
    isn't in the generated format (`../x`), and for a receipt from another server;
  - a plan with a malformed `uses` or an unknown `risk` never gets a plan hash;
  - a principal key file writable by the server's user, or in a directory it can write, is
    refused;
  - a partly failed reservation releases the reservations already made;
  - an HTTP server with a `total` limit on the memory store refuses to start.
- **End-to-end tests** live in `mcp-ts` and `mcp-py`, with in-memory MCP clients: 2026-era,
  2025-era (TypeScript through the SDK's legacy shim, Python through an in-call
  `session.elicit_form`),
  and no elicitation.

## Boundaries

- **Always:** fail closed; bind approval to the plan hash and the input; consume approvals
  once; keep secrets out of `requestState`; keep the SDK core zero-dependency; ship TypeScript
  and Python together.
- **Ask first:** changing SPEC.md or the wire format; storing anything beyond hashes in the
  state; changing a default in a way that runs more without asking.
- **Never:** treat a bare accept as approval; let the model approve; accept an unsigned
  approval, or an unsigned policy that loosens the defaults; trust a principal key the agent
  can write; use sampling; auto-run anything but `plans[0]`.

## Success criteria

- Both languages pass `conformance/approval.json`.
- A resent approved call runs once. A call whose plans changed asks again. A wrong
  confirmation asks again, and three wrong ones refuse the call.
- Over the same policy, a job either runs, asks, or fails closed with consent codes, and never
  does anything else.
- `undo` works once within the window, from any process, and never outside it or for another
  principal.
- An unsigned approval, an unsigned policy that would loosen the defaults, or a writable
  principal key is rejected. Only the principal's signature can make something run without
  the form.
- A policy with no limits (`can`, `risk`) works for any tool, and a plan that doesn't report a
  measure is never held back by a limit on it.
- Concurrent auto-runs never go past a `total` limit, and a failed `apply()` releases its
  reservation.

## Decisions

These were open questions. They were adopted as proposed on 2026-09-27, when James asked for
the work to keep moving; any of them can be reopened. parley-05's review agreed with each.

1. **Explicit approval can go past the limits.** Limits only govern what runs without asking,
   and approved plans don't count against them (§5). `deny` covers what must never run.
2. **The person types a phrase the tool names for each plan** (the branch name, the
   recipient, the amount as written), or `approve` when it names none. Phrases are text only
   in v0.
3. **Remote servers.** Local, signed `yea approve` is enough for v0. Url-mode pages come
   later.
4. **Undo doesn't ask** within its window.
5. **SPEC.md's "MCP binding" appendix** comes after v0 ships.
6. **Count limits** are already in the protocol (`total` on any measure, SPEC.md §6.3), so
   they're signed like any other limit. **Signed `deny` and `outOfBand`** would need new
   caveats, so they come after v0. Until then, unsigned rules are best effort above a fixed
   floor (§2).
7. **Nothing irreversible runs without asking** in v0. Only undoable plans auto-run, as
   SPEC.md §4.3.1 requires, so `send_email` and most refunds always ask. Allowing named
   irreversible tools to auto-run would be a new, always-signed grant caveat: a protocol
   change.
