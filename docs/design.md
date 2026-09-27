# YEA — design decisions

Each section records a decision, the alternatives we considered, and why we chose what
we did. Where a measurement drove the choice, the numbers are included.

## A protocol, not conventions on HTTP

**Decision.** YEA defines its own frames, verbs, reply kinds, errors and authorization.
HTTP is one of four transports (§2.4), not the substrate.

**Alternatives.** (a) REST conventions plus headers (`Prefer: preview`, `Idempotency-Key`,
OAuth scopes). (b) A JSON-RPC method set (MCP's approach). (c) GraphQL mutations with a
dry-run flag.

**Why.** What an agent needs has to hold for *every* service it talks to: a preview before
side effects, consent bound to exactly what was previewed, delegated authority with
limits, output that fits a budget, and a text form the model can read. Conventions get
adopted piecemeal, and a preview header that only a third of APIs honor is worse than
none, because the agent can't rely on it. The same logic made HTTP a protocol rather than
a set of conventions on FTP. We kept an HTTP bridge because reach matters: it runs on
serverless platforms and passes through proxies, while the semantics stay YEA's.

## Intent → proposal → commit

**Decision.** State changes go through `INTENT` (inert), then `PROPOSALS`, then
`COMMIT`. `ASK` is read-only by definition.

**Why.** It's the minimal structure that makes an agent's mistakes cheap. The service,
which knows its own domain, spells out the consequences: effects, cost, risk and undo
window. The agent, or a human, commits to exactly that, and the proposal hash guarantees
it. A side benefit is that services can offer *alternatives* ("standard or express") that
CRUD can't express.

**The cost we measured.** The preview adds a round trip. In an early, unpublished run of
the benchmark (before the changes below), that made YEA use about 1.5× the total
input tokens of plain REST on a two-step order task, because every turn re-reads the
context. The fix is below.

## Policy-gated auto-commit

**Decision.** `INTENT` with `auto: true` commits the first proposal immediately if, and
only if, the request's grant authorizes it *without consent* and the proposal is
undoable (§4.3.1).

**Alternatives.** An agent-side flag with no service check, which is unsafe. A separate
`DO` verb, which duplicates `INTENT`'s semantics. Always preview, which we measured as too
slow.

**Why.** It puts the review/speed trade-off where it belongs, in the **principal's
signed policy**. "My agent may move meetings and spend up to $40 on anything it can undo"
becomes one round trip. Anything outside that falls back to proposals automatically.
Irreversible actions never auto-commit. In the scripted payload benchmark this took the
reschedule task from 3 calls to 1, and YEA sends 32% fewer tokens than minified-JSON
REST (43% against pretty JSON; only ~4% against an equivalent outcome-level REST endpoint).
In **live** agent runs ([bench/agent-eval](../bench/agent-eval/)), total cost comes out
about even (+3–15% per task): turns dominate cost there, and models don't always hand
their goal straight to an intent. When they do, it's 1 call instead of 3.

Auto frames are replay-safe: the proof is bound to `auto:{capability}:{frame id}`, and
services dedupe `(key, id)` for 600 s. An independent implementer found that attack
during review.

## Lens: the model's view is part of the spec

**Decision.** Every reply has a canonical text rendering, specified to the byte (§9) and
checked by conformance vectors.

**Alternatives.** Leave presentation to clients (what every API does today). Markdown
(ambiguous and verbose for data). YAML (whitespace-significant and verbose for lists of
records). Pure JSON (what REST gives models: quotes, braces and repeated keys on every row).

**Why.** The model *is* the client, so its view is part of the interface. Specifying it
buys three things:

1. **Compactness where it counts.** Uniform lists become tables that name their keys once
   (`items[60]{sku,name,usd,cal,protein}:`), strings are unquoted when safe, and effects
   use one-character operators (`~ update`, `+ create`, `$ charge`). The 60-item menu
   costs 1,095 tokens in Lens against 1,919 minified and 3,019 pretty-printed.
2. **Consistency across services.** A model that has read one YEA receipt can read all of them.
3. **Budgets that mean something.** A budget constrains the rendering the model actually reads, not a JSON byte count.

Shared proposal attributes (cost, risk, undo, expiry) are stated once in the header.
Receipts don't repeat effects the model has already seen, unless the service
auto-committed. Both rules came out of the benchmark.

## Budgets and the shared token estimate

**Decision.** Budgets are in "tokens" measured by one regex that every implementation
computes identically (§8), not by any model's tokenizer.

**Alternatives.** Bytes/4 (the classic rule of thumb, and our first draft). A real
tokenizer (model-specific, large, and different in every language).

**Measurement.** Compared to o200k BPE counts over 25 texts (conformance Lens outputs,
benchmark payloads, and the menu as JSON and as Lens), reproducible with
`node bench/estimator.ts`:

| Estimator | mean ratio to real tokens | range |
|---|---|---|
| `ceil(bytes / 4)` | 0.61 | 0.37 – 1.00 |
| `ceil(bytes / 3)` | 0.82 | 0.47 – 1.35 |
| **`[A-Za-z]+\|[0-9]{1,3}\|\n {2,}\|[^ \t\n\r\f\vA-Za-z0-9]`** | **1.00** | **0.77 – 1.55** |

Bytes/4 undercounts structured text by up to 2.7×. It estimates the full menu's Lens at
623 tokens when it's really 1,095, so an "800-token" budget let the whole thing through.
The regex tracks real tokenizers on the text YEA actually sends, and it's four
alternatives long.

**Elision safety.** Budget fitting may drop whole trailing proposals or capabilities, and
may elide anything inside `data` and `result`. It may **never** alter a proposal's
effects, summary or hash, because the model has to see exactly what it would commit.
(The first TS draft could truncate effects inside the proposals list. The Python
implementer caught it.)

## Grants

**Decision.** Authorization uses public-key **capability chains**: a principal signs a
root block (holder key and caveats), and each holder may append a block that delegates a
narrower grant to another key. Every request that uses a grant carries a proof of
possession signed by the holder key.

**Alternatives.**
- *API keys / bearer tokens:* all-or-nothing, and a leak is total.
- *OAuth 2 scopes / JWT:* identity-centric, and scopes are coarse strings. There's no
  standard for spending limits or risk ceilings, and delegating to a sub-agent means another
  round trip to an authorization server.
- *Macaroons (HMAC):* the right attenuation model, but verification needs the root
  secret, so only the minting service can check them.
- *Biscuit:* public-key and attenuable, with a Datalog policy language. Powerful, but a
  heavy dependency for every implementer, and its generality works against a fixed
  fail-closed caveat set.
- *UCAN:* the closest relative. It's built on DIDs and JWT/IPLD encodings and designed
  for resource capabilities. YEA's needs are narrower and more agent-specific: spend
  accounting, risk ceilings, and consent bound to a proposal hash.

**Why this shape.**
- **Offline and decentralized.** Any service that trusts a principal's key can verify
  a chain without calling anyone, and delegating to a sub-agent needs no server.
- **Monotonic.** Caveats only accumulate, so a delegation can only narrow.
- **Fail-closed.** Unknown caveats *and malformed values* are hard failures, so an
  older service never over-authorizes a newer grant, and `{"svc": "a.example"}` (a
  string, not a list) doesn't sneak past through a substring match.
- **Agent-shaped caveats:** `per` and `spend` (money), `risk` (a ceiling on what the
  agent may do without asking), and `only` (consent bound to one proposal hash).
- **Consent is just a grant.** A human approval is a root grant with
  `[{svc: [service]}, {verbs: ["COMMIT"]}, {can: [capability]}, {only: hash}, {exp: …}]`.
  No new machinery, and it's cryptographically bound to the exact effects the human
  saw. The first draft had only `only` and `exp`. Because `only` constrains `COMMIT` alone,
  that grant would have authorized every other verb, including `UNDO` of unrelated
  orders, until it expired. The Python implementer found it by exploiting it, and
  the scoping caveats are now required by the spec.
- **Soft vs hard failures.** If only `per`, `spend` or `risk` fail, the service replies
  `consent_required` rather than `forbidden`. That's the protocol-level "ask the human."

## Wire format

**Decision.** UTF-8 JSON frames, newline-delimited, multiplexed by `id`, over any
reliable byte stream (TCP, TLS, stdio) or the HTTP bridge.

**Alternatives.** Protobuf/gRPC (a schema compiler for every implementer and opaque on
the wire). CBOR (compact, but it saves bytes where bytes don't matter). HTTP/2 streams.

**Why.** An agent round trip costs seconds of model time and thousands of tokens.
Serialization overhead is noise next to that. JSON is universal, debuggable with `nc`,
and trivially implemented: the Python implementation needed no dependencies beyond
Ed25519. NDJSON gives streaming (`EVENT` progress frames) and multiplexing for free.

**Canonical JSON** for hashing and signing allows only integers. Floats have no
cross-language canonical form, so money is in minor units (`1250` = 12.50 USD).
Proposal `data` is excluded from the hash, so services can put floats there.

## Why TypeScript for the reference implementation

**Decision.** The reference is TypeScript with **zero runtime dependencies**, using
WebCrypto Ed25519. The second implementation is Python, built independently from the
spec.

**Alternatives.** Rust (then bindings), Go, or Python first.

**Why.**
- *Where agents run.* Agent harnesses, MCP servers, edge functions and browsers are
  overwhelmingly TS/JS and Python. A reference in one of them is directly usable; a Rust
  core would ship through bindings in both.
- *One codebase, every runtime.* The core uses only web-standard APIs (WebCrypto, `fetch`,
  streams), so the same build runs on Node ≥ 20, Bun and Deno (all tested). It targets
  Cloudflare Workers (`fetchHandler`) and browsers (the `http` client) too, though those
  aren't in CI yet.
- *Performance is irrelevant here.* Verifying a grant is microseconds, while a model turn
  is seconds. There's no hot path for Rust to win.
- *Two languages keep the spec honest.* The Python implementation started from `SPEC.md`
  and the vectors (its first cut passed 63 of 67 vectors before its author had read any
  TS). It was then aligned with the TS source where the spec was silent. That
  cross-reading surfaced real gaps and bugs: Lens float formatting, rounding, fail-open
  caveats, elision of effects, replayable auto frames, and a consent grant that was
  far broader than one proposal. Each fix went into the spec and vectors, not just the
  code.

## Security review

After both implementations existed, the TypeScript reference got an adversarial audit.
It confirmed 15 findings, and every one now has a regression test in
`ts/test/security.test.ts` plus, where it's protocol-level, a SPEC change:

- **High:** a malformed or aborted HTTP request crashed the bridge process. Concurrent
  commits could exceed a `spend` cap, because spend was counted after execution; it's
  now reserved atomically (§6.3). A malicious service could get the MCP bridge to ask
  the human to sign a consent for a *different* service's proposal behind a friendly
  summary. Consent is now built only from the proposal the bridge showed, and it's
  checked against the service's request (§6.6).
- **Medium:** a proposal from an anonymous `INTENT` could be committed by someone else's
  agent. Proposals are now bound to the requesting key (§4.4). A replayed `COMMIT` could
  leak another principal's receipt, and the `conflict` error leaked the hash. A retried
  commit could be refused by the spend it had itself used up. Levenshtein "did you mean"
  suggestions were a CPU DoS on huge names.
- **Low:** unbound `EXPAND` handles, a dedupe window shorter than proof validity,
  `risk: "toString"` failing open, a mismatched `re` on concurrent failing `UNDO`s,
  grant selection that ignored the proposal's principal, an unenforced 1 MiB frame
  limit, unbounded state maps, and `checkGrant` throwing on a `null` caveat.

## Non-goals and known limits (v1)

- **The principal key must be isolated from the agent.** Everything rests on it. If an
  agent can read the principal key, it can sign its own consent. The CLI supports
  keeping it elsewhere (`YEA_PRINCIPAL_HOME`), and approval requires an interactive
  terminal, but a local shell-capable agent on the same account defeats both.

- **Services are trusted to describe their own effects.** YEA makes the description
  explicit and binds commits to it, but a malicious service can still lie. Signed
  receipts (below) make lies attributable.
- **No revocation.** Keep grants short-lived with `exp`.
- **`per` alone doesn't bound a purchase.** A per-commit cap can be dodged by splitting.
  In our [real Claude session](claude-code-session.md) the model pointed this out itself
  and declined to do it. `spend` bounds *total* exposure, but splitting within it is
  still possible, so size `spend` as the most you're willing to lose.
- **`spend` accounting is per service.** A grant used at two services has two
  independent totals. Scope money grants with `svc`.
- **Lens is English-centric.** Its keywords (`cost`, `undo`, `risk`) are fixed tokens,
  not UI strings.

## Roadmap

- **Revocation lists**, published by principals and checked by services.
- **`HOLD`: multi-party atomic commits.** Collect proposals from an airline and a hotel,
  hold both, then commit both or neither.
- **Signed receipts** for non-repudiation and audit logs a principal can verify.
- **Discovery by DNS** (`_yea` TXT → endpoint), alongside `/.well-known/yea`.
- **QUIC / WebTransport** transport.
- **More implementations.** Go and Rust ports are welcome, and `conformance/` is the
  contract.
