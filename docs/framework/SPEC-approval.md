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

Nothing the model passes is an approval; a consent signed by the pinned key, which the model
may carry back from the person (§6), is checked as one from the store. A replayed or stale
approval never runs anything. Both hold only as far as the principal key, the principal's
public key and the store are out of the agent's reach. What an approval proves about the person
depends on the step that produced it: a form answer is only as trustworthy as the client that
draws it ([§9, What an approval proves](#what-an-approval-proves)).

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

### The job call session

The SDK core runs this diagram as one **job call session** (`jobCall` in TypeScript,
`yea.job_call.job_call` in Python). It's a step function: each round of a call is one step,
which takes
- the call's facts: the tool (name, risk, whether it has `revert`, its phrase), the input, the
  handler, `preview`, `sub`, the time, the policy, and whether the client can take a form;
- the store;
- on a retry, the state the last round handed out, as it came back, and the person's answer.

It returns one outcome: `clarify`, `preview`, `run` (a plan, how it was allowed, and the
reservations it holds), `ask` (the form and the state to carry round the client), `consent-codes`
(§6) or `refuse` (with why). The session owns the order: deny before the handler runs, a consent
consumed before its plan runs, reservations after the decision, the state checked and its nonce
consumed before the answer is judged. The MCP packages only read the request, carry the state,
turn outcomes into results, and apply the plan a `run` names: settling its reservations if
`apply()` succeeds, and releasing them if it fails. A developer's error (a non-integer input, a
handler that returns neither plans nor a clarification, a phrase no one can type) and a store
failure raise before anything runs, and the call is refused with the message.

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
- A plan whose summary, effects and uses, taken as one object, nest objects and arrays more
  than 32 levels deep (that object being the first) gets no plan hash and fails closed, and
  `yea approve` refuses a consent code carrying one: the form would cut part of what the person
  approves (SPEC.md §6.6, §9.1).
- A plan is **undoable** if and only if its `undoWindow` is a positive integer of at most 2^52
  seconds (so a commit time plus it is still a safe integer, SPEC.md §5.1) and its tool has
  `revert` (§7). Any other `undoWindow` (zero, negative, a fraction, a larger number, a string,
  `null`, anything that isn't a number) leaves the plan not undoable, as having no window does.
- The preimage carries `undoWindow` only when the plan is undoable, so a plan that isn't hashes
  as if it had no window. Everything that shows a plan (the form, the MCP results and
  `yea approve`) reads its undo from that one field: the window as a duration when it is there
  and a positive integer, and `undo: never` otherwise.

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
3. **it can be undone** (§1): its `undoWindow` is a positive integer and the tool has
   `revert` (§7);
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
tightenings still apply. A file that isn't valid JSON is ignored the same way. The MCP adapters
are stricter, since a dropped `deny` would let a tool run (SPEC-mcp-ts, SPEC-mcp-py): a
`policy.json` they can't read refuses every job call, and a `tighten` option they can't read
refuses start-up.

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
  `approve`. A phrase must be typeable: printable text (`printable(phrase) === phrase`) of at
  most **64 characters** (Unicode code points, counted as the tool names it, edge whitespace
  included) whose only inner whitespace is plain spaces. Once the edge set below is stripped, a
  tab or any other space separator (`Zs`, such as U+00A0 or U+2003) inside it is refused.
  Anything else is a developer error, refused before the person is asked: the form shows a
  phrase escaped, and no one could be sure of typing the raw characters. The check is on the
  phrase as the tool names it, before the `approve` fallback, and there is no fallback for it.
  The job call fails as a tool error, and `yea approve` refuses a consent code whose phrase
  isn't typeable. The phrase must also be a **pure function of the plan and the input**: the
  same plan hash always gets the same phrase. A consent binds the phrase (§6), so a phrase that
  reads anything else (a counter, the time, a live balance, the locale) makes every consent for
  that plan unredeemable. Look-alike letters (homoglyphs, such as a Cyrillic `а` for a Latin `a`) are out of scope: they are
  printable, so this rule can't tell them apart. The field's description shows the exact
  phrase; with several plans, the message names each plan's phrase next to it. Denied plans
  are listed apart as never allowed, and when no plan can be offered at all, there is no form:
  the call fails closed with consent codes (§6).

Service text is untrusted, even when the server's own code writes it: a summary often carries
a customer's name or a remote record. So every string the form shows goes through `printable`
(control, format, line/paragraph-separator and invisible filler characters become `\u{…}`
escapes, as in §6): the reason, each summary, each phrase (a second line of defense: a
phrase that isn't typeable is refused above), and each `oneOf` title. An effect line is
rendered from its fields made one line (`oneLine`), keeping `from` and `to`, which Lens quotes
itself, and the whole line then goes through `printable`. A summary can't add a line to
the message or hide characters in it. The conformance cases pin this, and
`conformance/printable.json` pins which code points `printable` escapes and which it leaves alone.
`printable` is idempotent: it never escapes a backslash, so its output is its own fixed point,
and it's safe to apply over text that is already escaped or Lens-quoted. A `\u{…}` in service
text may therefore be literal, but every unsafe control or invisible character is always escaped.

An accepted form counts as approval **only** when `confirm` matches the phrase: both sides are
NFC-normalized, then stripped of leading and trailing characters in **exactly** this set:
U+0009 to U+000D, U+0020, U+00A0 and U+FEFF (not `trim()` or `strip()`, which strip different
sets), then lowercased with `toLowerCase()` / `str.lower()` (not `casefold()`, which has no
JavaScript equivalent). A tool must derive its phrase from the plan or the input, which the
plan hash covers. The rule and its edge cases are pinned in the conformance cases.

A bare accept or an empty form never counts: some clients auto-accept forms that have no
fields. This proves the form was filled in, not that a person read it. That is the level form
mode can give, the form tier ([§9](#what-an-approval-proves)).

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
- a **consent code** for each plan that may be approved (not for denied tools),
- a **short id** for each code, when the server's store is a `FileStore` (below), and
- how to approve, in these lines (`<id>` and `<code>` literally, then one line per plan):

  ```
  Ask the user to run `yea approve <id>` in a terminal outside this chat, then call this tool again with the same arguments.
    [1] yea approve k7m2x9qa4b
  If `yea approve` can't find the id (run as another OS user, or on another device), give it the whole code instead:
    code for [1]: pc1.…
  If the user pastes back a consent that `yea approve` printed (pg1.…), call this tool again with the same arguments and `yea_consent` set to it.
  ```

  Without ids (the store isn't a `FileStore`, or a pending file couldn't be written), the first
  line names `<code>` instead, and the id lines and the line after them are left out. The last
  line is always there: a consent comes back on the call wherever `yea approve` can't save it
  where the server reads (below, "A consent on the call"). The words *outside this chat* are
  there because a client's own shell (Claude Code's `! command`) gives `yea approve` no
  terminal, so it refuses there. `howToApprove` (`how_to_approve`) builds these lines, and
  conformance/job-calls.json pins them for both languages.

When no consent can be accepted here, there are no codes, and the result says why in one line:
*No consent can be accepted: …*. With no pinned principal key, the reason is *no principal key
is pinned (`<why>`): run `yea doctor` in a terminal outside this chat; it says how to pin one*,
where `<why>` is what the key check found (`YEA_PRINCIPAL_PUB is not set`, say), and the
brackets are left out when there's nothing to say.
The model reads this line, so it names a command that changes no keys. No tool result names
`yea init` or `--with-principal`, which make a principal key: an agent told to could run them
itself, and the key would land on its side (ADR-0003).

The consent code is the existing unsigned `pc1.` code: SPEC.md's consent request, with the
plan's details. For a job, its `detail` is `{ job, phrase, store }`: `job` is the full
plan-hash preimage (`tool`, `input`, `summary`, `effects`, `uses`, `risk`, and `undoWindow`
when the plan is undoable, §1), `phrase` is what the person types, after the `approve`
fallback (§3), and `store` is the id of the server's store (§8), the one that will consume the
consent. The **consent preimage** binds that phrase and that store to the plan, whose hash
already covers `job`:

```
consentHash = b64url(sha256(canonical({ plan: planHash, phrase, store })))
```

**Why the store.** A consent is used once in the store that consumes it (`consumeOnce`), so
it must not run in any other. Servers that share a key but not a store, such as a connector's
stdio and HTTP sides, or one server restarted on a `MemoryStore`, would otherwise each run the
same consent once. Bound to one store's id, a consent approves no plan in any store made
separately, where the consent hash comes out different, and it runs nothing there (a copy of a
store keeps its id; see §9).

The code's fields are `proposal` = the plan hash, `hash` = the consent hash, `service` = the
server's service id, `capability` = the tool, `principal` = the pinned principal key,
`summary`, and `expires` = now + 10 minutes. Nothing in the code is trusted until it is
recomputed: an edited phrase no longer matches `hash`, and a code whose `hash` was recomputed
to match an edited phrase gets a consent the server never honors, because the server checks
it against its own phrase. `consentHash` applies the `approve` fallback to the phrase itself, so
an empty or blank phrase hashes as `approve`.

`yea approve <code>`:
1. recomputes the plan hash from `job`, then the consent hash from it, the phrase and `store`,
   and refuses if they don't equal the code's `proposal` and `hash`, if the phrase isn't
   typeable (§3, so one over 64 characters is refused), if `store` isn't a store id (§8), if
   the code's `capability` isn't the plan's `tool`, or if the code has expired (saying when,
   and the time on this machine, so a wrong clock shows); it caps `expires` at 10 minutes from
   now, whatever the code says;
2. shows the plan, never only a summary, in which control, format, line/paragraph-separator
   and invisible filler characters are shown as `\u{…}` escapes (`printable` itself keeps
   backslashes, §3), so the text can't rewrite what the person reads, and its undo as the form
   shows it (§1: `never` unless `job` carries an `undoWindow` that is a positive integer);
3. asks the person to type the plan's phrase (§3), the same check as the form (an empty
   phrase falls back to `approve`);
4. signs a **consent grant** (`pg1.`) with the principal key, issued **to the server's key**,
   with `[{svc:[service]}, {verbs:["COMMIT"]}, {can:[tool]}, {only: consentHash}, {exp}]`, and
   prints it on stdout. It saves it under the plan hash in its store (`YEA_STORE`, else
   `$YEA_HOME/store`, else `~/.yea/store`) only when that store's id is the code's `store`: then
   it's the store the server reads, and in any other the consent could never run. It reads that
   id without making one, since a store with no id issued no code. Then it says where the
   consent went: saved where the server reads it, so nothing needs pasting back and the agent
   can call the tool again; or not saved, because the code is another store's or the save
   failed (and why), so the person pastes the printed consent back into the chat. A failed save
   doesn't fail the approval: the consent was signed, and the call can carry it.

When there is no terminal (stdin isn't a TTY), `yea approve` refuses before asking:
*approval needs an interactive terminal: a person has to confirm, so run it in a separate
terminal window, not through the agent*.

#### Short ids

So the person needn't copy a 1.5 KB code out of the chat, each issuer also writes the code to
a **pending file**, under a short id, where `yea approve` on the same account finds it:

- a framework server, in its store: `<store>/pending/<id>`, where the store is `YEA_STORE`, else
  `<home>/store`. A store that isn't a `FileStore` gets no files;
- the bridge, in its home: `<home>/pending/<id>` (SPEC-bridge step 6).

A result names ids only when every one of its files was written; otherwise it gives the codes
alone, and approving works as before.

**The format**, pinned by `conformance/pending.json`:
- The file's first line is the `pc1.` code verbatim. A server's file is that line alone
  (`<code>\n`). The bridge's adds a second naming the process that wrote it, `{"pid":<pid>}`
  in canonical JSON, for its start-up cleanup and the listing (SPEC-bridge step 6). A home is
  one account's on one machine, so its pids are that machine's. `yea approve` reads the first
  line only. A file holds nothing else: no field
  `yea approve` would trust, and never a key or seed.
- `<id>` is 10 random characters of lowercase base32 (`a`–`z`, `2`–`7`), made by the issuer. An
  id never starts with `-`, so the command line never reads one as a flag.
- The directory is created `0700` and the file `0600`, written to a temp file and renamed (§8).
  If the store is ever shared with the principal's OS user
  ([#376](https://github.com/yea-protocol/yea/issues/376)), `pending/` must stay readable by
  that user.

**The lifecycle.** A directory holds at most one file per service and proposal, the code's
`service` and `proposal` (a plan hash, or the bridge's proposal id):
- Writing a code for a service and proposal that already have a file rewrites that file and
  keeps its id, so an id the model passed on earlier still works. Any other file for the same
  pair is removed.
- Every write also removes the files whose codes have expired. A code expires when the consent
  `yea approve` would sign for it does: with the code, or with its proposal if that's sooner
  (SPEC-bridge, "yea approve"). A job code's detail has no `expires`, so it expires with the code.
- A plan that runs removes its files, whether it ran on its own, from the form or with a consent.
- The bridge removes an entry's files when it drops, replaces or commits the entry, or when a
  proposal loses its code. At start-up it removes the files whose process has ended, never a
  running bridge's (SPEC-bridge step 6).

**`yea approve` with no argument** lists the pending codes under each directory's name: the
home's `pending/`, then the store's (`<home>` is `YEA_HOME`, else `~/.yea`; the store as above).
Each code is one line: its id, capability, summary, service and expiry (its consent's, as
above). The service-written fields have their whitespace runs collapsed to one space, the
summary is cut to 80 code points, and then each goes through `printable`. Expired codes are left
out. A line ends with *its
bridge has stopped: call the tool again* when the file's process has ended, or with *approved,
waiting for the agent* when a consent for it is already saved (in the home under its `hash`,
or in the store under its plan hash).

**`yea approve <id>`**:
1. accepts only an id matching `^[A-Za-z0-9_-]{8,32}$`, exactly: there is no prefix search,
   and nothing but the id reaches a path;
2. looks for `pending/<id>` in the home and in the store, matching each directory's names
   exactly before it opens anything, so a case-insensitive disk can't hand back another id's
   file. An id in both is refused, naming both directories: it doesn't name one approval;
3. opens it without following a symlink, and refuses anything but a regular file of at most
   64 KiB;
4. takes its first line as the code, and from there is `yea approve <code>`, unchanged: every
   check above, the plan in full, the phrase, and where the consent is saved. Nothing in the
   file is trusted that a pasted code isn't. A first line that's empty, or isn't a consent
   code, is refused as *pending file `<path>` doesn't hold a consent code*, and the file is
   never quoted, not even in a parse error.

An id it can't find is refused with where it looked, and one whose code has expired with where
it is. Every refusal of an id says *call the tool again for a fresh one*.

**Short ids are a one-account convenience**, for trying YEA on one machine. There they are
form tier ([§9, What an approval proves](#what-an-approval-proves)): the agent runs as the same
OS user, so it can run `yea approve` itself, and a terminal isn't a person. Another OS user or
device keeps the whole code.

On the next identical call, the server looks up a consent for each recomputed plan's hash and
checks it against that plan's consent hash, recomputed from the plan, the phrase the tool names
now, and its own store's id: it must be a single root block that itself carries `only` = that
consent hash and an `exp` (so neither a copied policy grant nor a block the server's key
appended to one ever counts), and pass the grant check as a `COMMIT` of the tool at this server,
signed by the pinned principal key (§2). It then consumes it with
`consumeOnce(<consent grant id>, exp)`, and runs that plan. Consents are keyed by plan hash, not
by code, so a fresh code for the same plan still finds them; a consumed or expired one counts as
absent, and the server issues fresh codes. Denied tools and plans that aren't recomputed are
never run. An unsigned approval in the store is never accepted.

A consent for another phrase is refused, but not silently. The grant check runs against the hash
the consent binds, so a consent that is otherwise valid but binds another hash (another phrase,
or another store's id) is told apart, as `not a consent for this phrase`. When the call then
asks (a form or fresh codes), the reason it gives is *"a consent for this plan was signed for a
different phrase; approve the new code — if this repeats, the code you were given may have been
altered"*. The person can then tell a changed phrase or an edited code from a lost consent. A
consumed, expired or malformed consent leaves no such reason.

**A consent on the call.** The consent `yea approve` prints can also come back on the call,
so the server and `yea approve` needn't share a store. The person pastes it into the chat,
and the agent calls the tool again with the same input and the consent as `yea_consent`.
Every job tool takes that argument beside `preview`. It's a string, the `pg1.` grant as
printed; absent or `null` means the call carries none, and any other type is an invalid
argument. The edge set a typed phrase loses (§3) is stripped from both ends first, so the
newline a terminal copy often carries doesn't matter: the signature covers nothing outside the
token. It's taken off before the input is validated, so it's no part of the input, the plan
hash or the input hash, and a tool's own input may not have a field of that name.

A first round that carries a consent (a preview doesn't read it, and a retry is judged on the
form's answer alone) checks it **exactly as a stored consent**: against each recomputed plan in
order, a single root block carrying `only` and `exp`, passing the grant check as a `COMMIT` of
the tool at this server signed by the pinned principal, with `only` equal to that plan's consent
hash, which binds this server's store. It then consumes it with
`consumeOnce(<consent grant id>, exp)` and runs that plan. A consent is used once, whichever way
it arrived, and only in the store it binds. If it approves no plan, nothing runs that round.
Neither a stored consent nor the policy is consulted, and the call asks (the form, else fresh
consent codes) with the reason `the consent passed as yea_consent can't be used: <why>`, where
`<why>` is the first that applies:

| `<why>` | when |
|---|---|
| why no principal key is pinned | there's none (as for consent codes) |
| `it isn't a consent from yea approve` | it doesn't decode as a single-block grant with `only` and `exp`: a value mangled on the way lands here |
| `it has expired` | the grant check fails and its `exp` is past |
| `it isn't signed by the pinned principal for this tool at this server` | the grant check fails otherwise: forged, altered, or for another server or tool |
| `it approves none of these plans; if the person approved this exact request, this server may have restarted since or not be the one that asked, or the code they were given may have been altered` | it passes, but binds no recomputed plan's consent hash: another plan, other input, a phrase that changed, an edited code, or another store's consent |
| `it was already used` | its grant id was already consumed |

A call whose handler returns no plans is refused before any consent is read, as it is without
one (`<tool> has no way to do this`). These reasons are fixed
text, pinned by the job call cases, so both languages say the same.

Carrying a consent through the chat gives the model nothing to forge. Nothing the model passes
is an approval; a consent signed by the pinned key is checked as one from the store. The bytes
are the principal's signature over one plan, its phrase and the store that consumes it, issued
to this server's key, so a model that changes one character turns it into a refusal. It costs
about a kilobyte of chat. The bridge takes the protocol's consents the same way (SPEC-bridge
`yea_consent`), and so does a `COMMIT` that carries one (SPEC.md §6.6).

The store route needs a store shared by the server and the `yea` command: a local stdio server
with `FileStore`, on the person's own account. The call route needs nothing shared, so it
serves a server under another OS user, on another machine, or over HTTP with a `MemoryStore`.
Url-mode approval pages come later.

### 7. Undo

A plan is undoable when its `undoWindow` is a positive integer (§1) and the tool defines
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
  getConsent(planHash: string): Promise<string | null>;              // a pg1. consent grant, or null if none can be read
  storeId(): Promise<string>;                                        // this store's id, which a job consent binds (§6)
}

type LedgerKey = { block: string; of: string };  // a policy grant block id and a measure
type Reservation = { key: LedgerKey; amount: bigint; id: string };
type JobReceipt = Receipt & {                     // SPEC.md's receipt, plus what undo needs
  service: string; tool: string; input: unknown; planHash: string; sub: string;
};
```

Amounts are the SDK core's `exact()` values: integers at scale 18. What `decide` reads is
`used(k)`: the settled plus reserved amount for a block and measure.

**The store id.** Every store has an id, which a job consent binds (§6), so a consent runs in
one store only. A store id is 22 b64url characters: 16 random bytes. It never changes for the
store. Two stores made separately never share one; a copy of a store shares it (§9):
- A `MemoryStore` makes its id when it's made, so a restarted server's store has a new one.
- A `FileStore` keeps its id in `<root>/id`, so every process that shares the root, and
  `yea approve`, reads the same one. The first process that needs it writes a temp file and
  links it into place, so it's created once, and whole, whichever process wins. Where the
  filesystem has no hard links (`link` fails with `ENOTSUP`, `EPERM` or `ENOSYS`: FAT, exFAT,
  many SMB shares), it does the same under a lock file, `<root>/id.lock`, taken as a ledger
  lock is (below): it looks again, and only if there's still no id renames the temp file into
  place. A file there that isn't a store id, or can't be read, is a store error, and nothing
  runs; so is an id that can't be made.
- A custom store (Redis, SQL) keeps one id for everything that shares it, made once with
  `newStoreId()` (`new_store_id()` in Python) and kept with the rest of its data.

The job call session reads the store's id once a round, before it reads a consent or issues a
code. An id that isn't a store id is a store error there, so nothing runs and no code is issued:
a consent that binds no store would run once in every store with the server's key.

**Store selection.** Stdio servers use `FileStore` by default, because `yea approve` saves
consents there and undo across restarts needs it. HTTP servers use `MemoryStore` by default,
where a consent comes back on the call (§6), and one with a `total` limit refuses to start on
it unless the author passes `store` or sets `singleProcess: true`. A custom store (Redis, SQL)
is for multi-process servers: replicas of one server share one store, with a shared state key.
Never create a store by copying a used one (a volume snapshot, an image with a store baked in, a
copied home): the copy keeps the id, so a consent would run once in each (§9).

**`FileStore` format**, under `~/.yea/store/` by default (`$YEA_HOME/store` when `YEA_HOME` is set;
the MCP servers and `yea approve` use `YEA_STORE` first), pinned by the conformance
cases so the TypeScript and Python servers and the `yea` command share one store:

```
consumed/<b64url(sha256(id))>        empty marker, created with O_EXCL; holds exp as text
undo/<receipt id>.claim, .done       markers, created with O_EXCL; the claim holds a random token and stays after done
receipts/<receipt id>.json           the JobReceipt as JSON (read, not byte-pinned: results may hold floats)
ledger/<block>/<of>.json             {"settled": "<decimal>", "reserved": {"<rid>": "<decimal>"}}
consents/<planHash>                  the pg1. consent grant (plan hashes are b64url)
id                                   the store id (22 b64url characters, nothing else), created once
id.lock                              the lock for making `id`, only where the filesystem has no hard links
pending/<id>                         a consent code waiting for `yea approve <id>` (§6, Short ids)
```

Ledger files are `{"settled": "<decimal>", "reserved": {"<v_ id>": "<decimal>"}}`, updated under
an exclusive lock file (`<of>.lock` beside them, `O_EXCL`, retried every 10 ms for up to 2 s,
then a store error). The lock holds a random token: its holder re-checks the token before and
after writing, deletes the lock only if it still holds it, and reports a store error (nothing
runs) if the token changed. A lock older than 30 s is stale: a waiter reads its token, renames
it aside, and deletes it only if the moved file still holds that token; otherwise it links it
back where it can (without hard links it can't, and that lock's holder fails closed). Undo
claims hold a token too, and one older than 10 minutes with no `done` marker (the process died)
may be claimed again the same way. A holder paused for more than 30 s between its checks is the
one case lock files can't fully close; the check after writing turns it into a store error
instead of a silent overshoot. Files are written to a uniquely named temp file
(`<name>.<random>.tmp`) and renamed. Directories are created private (`0700`). Receipt ids are
`r_` and 12 b64url characters, reservation ids `v_` and 12. Expired markers may be removed after
`exp`.

**An unreadable consent is absent.** A consent is read the way a server key is: opened without
following a symlink and without blocking (`O_NOFOLLOW`, `O_NONBLOCK`), checked on the open file
to be a regular file, and read to at most 64 KiB. A `consents/` file that exists but can't be
read that way counts as no consent: a mode or owner that shuts the server out, a symlink,
directory, FIFO or device in its place, or more than 64 KiB. The server writes one line to
stderr naming the file and why. The call then asks as it would
without one. A consent only ever adds a way to run, so treating an unreadable one as absent
never runs more than the policy would. And the fs error, with its path, never reaches the
model's context. A file whose bytes aren't UTF-8 is no consent either: TypeScript reads it with
replacement characters, which no grant decodes from, and Python counts the decode error as
unreadable. Any other read the store makes that fails is still a store error, and nothing
runs.

## 9. Security

### What an approval proves

This is the threat model for approvals. The guides and the security guide link here rather
than restate it.

**A form answer proves only what the client stack attests, and MCP attests nothing about a
person.** An elicitation result carries no evidence of who answered it. Any client, SDK host,
proxy or gateway that declares form support can answer a form, as our own tests do with the
MCP SDK's client. The phrase doesn't change that: it's printed in the request (§3), so anything
that reads the form can type it. The phrase only stops a client that accepts empty forms.
What can answer a form in the clients we know is in the integrations guide,
[Who can answer a form](../../site/guide/integrations.md#who-can-answer-a-form). Those notes are
examples, not a list of safe clients.

**The tiers.** An approval is judged by what the agent can reach at the step that produces it,
not by what the approval is made of:

| Tier | The step that produces it | It proves | It proves a person acted only if |
|---|---|---|---|
| **Form tier** | an answer to the approval form (§3), or anything else triggered from inside the chat client | the client stack returned an accepted form whose `confirm` matches the phrase of the plan it names | nothing in that stack can answer or rewrite a form: no hook, auto-reviewer, model, proxy or script, and no config the agent can edit to add one |
| **Signed consent** | `yea approve <code>` (§6), where the principal key is | the holder of the principal key signed this exact plan | the key, and the prompt that triggers the signing, are outside everything the agent can drive: its shell, its files, and any browser it automates |
| **Client call prompt** (conditional: opt-in, [#338](https://github.com/yea-protocol/yea/issues/338)) | Claude Code's own permission prompt, before the call reaches the server, for a tool marked `_meta["anthropic/requiresUserInteraction"]` | whoever answered Claude Code's prompt allowed this call, with these arguments | the conditions below hold, including that no `PermissionRequest` hook answers the prompt |

**A signature is only as strong as the step that triggered it. Anything triggered from inside
the chat client is form tier**, whichever key signs afterwards, because a hook or a model can
supply the answer that triggers it. That's why no tool host signs with the principal key at
all (SPEC.md §6.6, ADR-0003), and why the bridge has no in-client signing
([SPEC-bridge](SPEC-bridge.md), decision 4). The same rule holds outside the chat: an approval
page ([#328](https://github.com/yea-protocol/yea/issues/328)) is form tier for an agent that can
drive the browser it's open in.

**The client call prompt** is opt-in, and off by default ([#338](https://github.com/yea-protocol/yea/issues/338)). With the `requireInteraction`
option on, YEA's tools that act carry `_meta["anthropic/requiresUserInteraction"]`, and Claude Code
prompts for every call of them in every mode that can prompt; `dontAsk` and
`--permission-prompt-tool` deny the call instead
([MCP](https://code.claude.com/docs/en/mcp#require-approval-for-a-specific-tool),
[permission modes](https://code.claude.com/docs/en/permission-modes#actions-no-mode-auto-approves)
and [permissions](https://code.claude.com/docs/en/permissions), fetched 2026-11-03). The
integrations guide's [Keep the prompt in auto or bypass mode](../../site/guide/integrations.md#keep-the-prompt-in-auto-or-bypass-mode) is the recipe, with
the Claude Code versions, and
[The Claude Code call prompt](../../site/guide/integrations.md#the-claude-code-call-prompt) says
what the prompt shows.
- **It doesn't prove** which plan the person chose, or that the form answer is theirs: the
  server computes the plans after the call, so the choice and the phrase still come back
  through the form. It proves nothing under an Agent SDK host, whose `canUseTool` callback can
  approve in code, and nothing when the option is off.
- **It depends on the option staying on.** Set by the server's author in code, it holds unless
  the agent can edit the server's source. Set by the person in the server's MCP entry
  (`.mcp.json` or `~/.claude.json`), it's in files that `bypassPermissions` lets the agent
  write without asking, and that `auto` leaves to its classifier.
- **It depends on no `PermissionRequest` hook matching the tool.** That hook runs when Claude
  Code is about to ask, and can allow "on behalf of the user". The hooks page says a
  `PreToolUse` hook's `allow` can't skip this prompt, but it doesn't say whether a
  `PermissionRequest` hook's can ([hooks](https://code.claude.com/docs/en/hooks), fetched
  2026-11-03). That hook comes from the same places, and reloads the same way, as the
  `Elicitation` hooks.
- **Together with the form,** it shows that a person chose the plan only when, in addition, no
  `Elicitation` or `ElicitationResult` hook matches the server.
- **Not yet known:** whether a `PermissionRequest` hook's `allow` skips the prompt, and whether
  the retry of a 2026-07-28 `input_required` call draws a second prompt. Both wait for the
  interactive check in [#372](https://github.com/yea-protocol/yea/issues/372).

**Today's status, for servers built with the framework:**
- **The key on the server's account:** best effort. An agent that runs as that user can read
  the key, or run `yea approve` itself: the command checks for a terminal, and a terminal isn't
  a person.
- **The key on another OS user:** works, with the consent pasted back on the call (§6). The
  signature holds; the store stays best effort under a stdio server, which runs as the agent's
  user ("What else must hold"). No test runs two OS users.
- **The key on another device:** works the same way. The person copies the code to the device,
  runs `yea approve` there, and pastes the consent back. Approval pages for web chat clients
  are [#328](https://github.com/yea-protocol/yea/issues/328).

The bridge's consent codes work the same way (SPEC-bridge, `yea_consent`).

**Choosing the tier.**
- **The author chooses it for each plan.** A plan at `risk: 'high'` is never offered in the
  form; it gets consent codes, whatever the person's settings say (the floor, §2). A tool's
  `risk` is only the default for its plans that don't set one ("How a job call runs"), so a
  plan that sets a lower risk still goes to the form. Whether the tool's risk should be a floor
  instead is [#369](https://github.com/yea-protocol/yea/issues/369). The Stripe
  connector does this in live mode: its refunds, immediate cancellations and changes, and
  dearer changes at renewal are `high` ([SPEC-connector-stripe](SPEC-connector-stripe.md)).
  The cost is a pinned principal key (§2): without one, a `high` plan can't be approved at
  all. Its consent comes back on the call, or through a store `yea approve` shares (§6).
- **The person can lower `outOfBand`.** It's a risk level, not a list of tools:
  `{ "outOfBand": "medium" }` sends medium and high plans out of band. Like every unsigned
  rule, it's best effort (§2): an agent that can write `~/.yea` can remove it.
- **The defaults leave most tools on the form tier.** A guarded tool's default risk is `medium`
  and `outOfBand` defaults to `high`, so the quickstart's irreversible `delete_file` is
  approved in the form.

### What else must hold

- **The key file check fails closed.** The plugin refuses the pinned key when it runs as root
  (root can write anything) and on platforms where it can't check file ownership.
- **Keep the agent away from three things.** The principal key (or it signs for itself), the
  pinned principal public key (or it swaps in its own), and the store (or it resets totals,
  deletes a `consumeOnce` marker or rewrites the store's id to replay a consent within its
  `exp`, or deletes receipts).
  `YEA_PRINCIPAL_HOME`, the write check on `YEA_PRINCIPAL_PUB`, and running the server as
  another OS user are how. On one account with a shell-capable agent, the guarantees are best
  effort, as the security guide already says for the principal key.
- **What a second OS user buys, and what it doesn't.** With the principal key under another OS
  user, who runs `yea approve` there and pastes the consent back (§6), the agent can't sign.
  It can't make itself a consent or a policy, and that holds strongly. The store doesn't move.
  A stdio server runs as the client's user, which is the agent's, so the store is still the
  agent's: it can delete a `consumed/` marker to replay a consent within its `exp`, reset a
  `total`, delete receipts, or delete or spoil a stored consent. Spoiling one is a denial, not
  a forgery: an unreadable consent only asks again (§8). So with two users, signing is
  strong and the store stays best effort. The store is out of the agent's reach too only with
  **three** users: the server as its own user (started through a wrapper in the client's
  config), the agent as another that can't read or write the server's store, and the
  principal as a third. The consent travels on the call in that layout as well. The guides
  don't walk through it yet, and the shared-store variants are #376.
- **A restarted server keeps its totals and receipts** only with a persistent store, which is
  why stdio defaults to `FileStore`. A consent used before a restart still can't run again: on
  a `MemoryStore` the restarted store has a new id, so the consent, which the model may still
  hold, binds none of its plans (§6). A form state can't either: a `MemoryStore` can't be given
  a shared state key, so the restarted server's new key refuses it.
- **Servers that share a key but not a store** (a connector's stdio and HTTP sides, or one
  server listed twice in a client's config) each keep their own one-time markers. A consent
  still runs in only one of them, the store it binds (§6). A copied store keeps its id, though:
  a `FileStore` directory baked into an image or copied with a home would run a consent once
  in each copy, so make a new store rather than copy one. Totals are another matter: each
  store keeps its own, which is why an HTTP server with a `total` limit refuses to start on a
  `MemoryStore` unless its author says it runs as a single process (SPEC-mcp-ts).
- **Short consents.** Consent grants expire in 10 minutes by default, which bounds a replay
  if a marker is ever deleted.
- **Fail closed** everywhere: an invalid state, a missing or unsigned policy, an unpinned key,
  a non-integer input, or a store error all mean nothing runs.

## Mapping to the protocol

| MCP framework | YEA protocol (SPEC.md) |
|---|---|
| Job tool call | `INTENT` with `auto`, then `COMMIT` of `plans[0]` |
| `preview: true` | `INTENT` without commit |
| Approval form and typed confirmation | Plays a consent grant's role for one plan, unsigned: the form tier (§9) |
| Consent code and `yea approve` | A `pc1.` consent request, then a `pg1.` consent grant signed by the principal |
| `yea_consent` on the call | A `COMMIT` re-sent with the consent grant (§6.6) |
| Signed policy | A grant signed by the principal, with its caveats; unsigned config can only tighten |
| `undo(receipt)` | `UNDO` |

The wire protocol doesn't change. SPEC.md gets an "MCP binding" section after v0 (decision 5).

## Where the code lives

```
ts/src/job-call.ts        the job call session: the decisions below, in their safe order
ts/src/approval.ts        plan hash, policy decision, reservations, undo
ts/src/ask.ts             form builder, state payload, answer check, consent codes
ts/src/store.ts           ApprovalStore, MemoryStore, FileStore
ts/src/cli/approve.ts     yea approve for job consent codes, and for pending ids
ts/src/cli/pending.ts     where yea approve looks for a pending id (the home, then the store), and the listing
ts/src/file-store/pending.ts  pending files (§6, Short ids)
ts/test/approval.test.ts  unit tests + the shared conformance cases
python/src/yea/job_call/, approval/, store/, python/tests/test_approval.py   the same, for Python
conformance/approval.json shared cases for the decisions, generated from the TS reference
conformance/job-calls.json shared cases for the session, a round per step
conformance/pending.json  the pending file's format, for every writer
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

- **Job call cases** (`conformance/job-calls.json`, from `ts/scripts/job-call-vectors.mjs`).
  Each call is a sequence of steps, a round of the session each. A step gives the round's facts
  (`now`, `sub`, `input`, `canAsk`, `preview`, `plans` or a clarification, `policy`, `unpinned`)
  and, on a retry, the `state` (`{ "fromStep": n }` for the one step `n` handed out) and the
  `answer`. It records the store `before` and `after` (`used`: each ledger entry the first
  step lists; `consumed`: the ids consumed so far, with a state's random nonce written as
  `nonce of step n`), whether the handler ran (`planned`), and the `outcome`: plans by hash and
  a state without its nonce. The first step's `before` sets the store up, with the call's
  `consents`; a step's `race` is reserved by another call between the decision and the
  reservation. They cover a denied
  tool, a run inside the policy, asking then answering, a wrong phrase three times, a replayed
  state, a declined answer, a state for other input or past its expiry, plans that changed, a
  chosen plan now out of band, a consent code consumed twice, a consent signed for another
  phrase, a limit that fills up between decide and reserve, no pinned principal, a
  clarification and no plans. A step's `consent` is the consent its call carries
  (`yea_consent`, §6); those cases cover one that runs its plan once, whether it came on the
  call or from the store, and each reason one is refused.
- **Conformance cases** (`conformance/approval.json`). Given plans, a policy and a ledger, both
  languages agree on:
  - the decision, and the reason text;
  - the plan hashes, and the refusal of non-integer inputs;
  - the form schema, including plans left out for `outOfBand`, and service text escaped in the
    message and titles;
  - the state plaintext;
  - how every answer is judged: accept, decline, cancel, a wrong confirmation (and three),
    an unknown plan, a replayed or resent state, other input, and plans that changed;
  - confirmation matching, with its whitespace and Unicode edge cases;
  - reading an unsigned policy file with loosening and unknown fields;
  - the `FileStore` on-disk format, and the pending file's (`conformance/pending.json`).
- **Unit tests** for the store: consume-once under concurrent calls, claim-undo once, and
  reservations under concurrency and failure. A `FileStore` whose filesystem has no hard links
  makes its id once, holding its lock file when it writes it, however many stores race for it;
  one whose lock is taken over while held makes none, and leaves the other's lock; any other
  failure to make it is a store error.
- **Security tests** in `ts/test/security.test.ts` and its Python counterpart:
  - an unsigned approval is rejected, and an unsigned policy can't loosen the defaults;
  - a consent for one plan can't run another, and a replayed state or consent runs nothing;
  - a consent code with an edited phrase is refused, and a consent signed for an edited phrase
    never runs; a phrase over 64 characters is refused;
  - a consent on the call (`yea_consent`) that is forged, altered, expired, issued to another
    key, for another server or tool, already used, or for another plan runs nothing, and never
    falls through to the policy;
  - a consent consumed in one store runs nothing in another with the same server key, and a
    `MemoryStore` server's consent runs nothing after a restart;
  - a store whose id isn't a store id runs nothing and issues no code, even for a consent that
    binds no store, and `yea approve` refuses a code that binds none;
  - an unreadable consent in the store (a planted mode-0 file, a FIFO or a symlink) asks
    again, with no fs error in the result;
  - an irreversible plan never auto-runs, whatever the grant says, and neither does one whose
    `undoWindow` is zero, negative or not an integer;
  - a `high` plan never auto-runs and can't be approved in the form, even as `plans[1]`;
  - no answer to the form, whatever it is, makes a signature or saves a consent, even with a
    principal key on the machine: in the session, and through real MCP clients of both eras in
    each language's MCP package. With the key placed before anything loads, nothing reads it
    and no other process or thread starts. The code that reads an answer imports only the
    modules its test lists, loads no code at run time, and names no signer (§9);
  - a `deny`ed tool never runs, even with approval;
  - deleting the unsigned policy file returns to the defaults, never to something looser;
  - undo refuses outside its window, for another principal, a second time, for an id that
    isn't in the generated format (`../x`), and for a receipt from another server;
  - a plan with a malformed `uses` or an unknown `risk` never gets a plan hash;
  - `yea approve <id>` refuses an id outside its pattern (`../x`), an id that differs only in
    case, an id in both directories, a symlinked or oversize pending file, a pending file whose
    plan or hash was edited, one that holds no code (never quoting it), and an expired one; a
    file naming another agent still needs `--to`; the listing keeps service text escaped and on
    one line; a pending file holds the code and nothing else, never a seed;
  - no tool result names `yea init` or `--with-principal`;
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

- Both languages pass `conformance/approval.json` and `conformance/job-calls.json`.
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
   in v0, at most 64 characters, and a consent code's phrase is bound by its consent hash (§6),
   adopted 2026-11-03 (#141).
3. **Remote servers.** Local, signed `yea approve` is enough for v0, with the consent pasted
   back on the call when the server can't read the store `yea approve` writes (decision 8).
   Url-mode pages come later.
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
8. **A consent travels on the call; a shared inbox comes later** (#358, adopted 2026-11-07).
   The consent `yea approve` prints can be passed back on the retry call as `yea_consent` and
   is checked exactly as a stored one (§6). That needs no shared filesystem, so it works for a
   server under another OS user, on another device, and over HTTP with a `MemoryStore`, and
   #328's paste-back can reuse it. A group-writable consents inbox in the server's store, which
   would save the paste on one machine with two users, is deferred (#376). It needs the
   store outside both users' homes (`~/.yea` is `0700`), the server rather than `yea approve`
   to create the inbox, file modes that a `umask` can't strip, and a two-user CI job to show it
   works. It also buys nothing against an agent that runs as the server's user, which owns the
   store either way (§9).
9. **A job consent binds the store that consumes it** (#358, adopted 2026-11-07). Its consent
   hash covers the store's id as well as the plan and the phrase (§6), so a consent runs once
   in all, not once per store: not again in a second server with the same key, and not again
   after a `MemoryStore` server restarts. The exception is a copy of a store: it keeps the id,
   so a consent runs once in each copy (§9). The id is in the consent code, so `yea approve`
   needs no store to sign, and saves the consent only in the store it binds.
