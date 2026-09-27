# Security model

YEA's safety comes from a few mechanisms that each close a specific gap. It also has known limits, listed at the end.

## Rule one: keep the principal key away from the agent

::: danger
Every protection below assumes the agent can't sign with the principal's key. If it can, it can issue itself any grant and approve any consent.
:::

`yea init` stores the principal key and the agent key side by side in `~/.yea`, which is convenient for trying things out. An agent with shell or file access, such as Claude Code, can read that directory. For anything real:

- keep the principal key on another OS user, another machine, or a phone;
- set `YEA_PRINCIPAL_HOME` to where it lives, and approve consent there;
- give the agent's machine only the agent key and its grants: `yea install` does exactly that by default, and `yea grant-import` brings over a grant issued elsewhere.

The spec requires this of tooling: implementations must not let an agent trigger signing with the principal key ([SPEC §6.6](/reference/spec#66-multiple-grants-and-consent)).

## What each mechanism stops

| Threat | Mechanism |
|---|---|
| A stolen grant token | Proof of possession: every request is signed by the holder's key, bound to the service, verb, target and a timestamp within 300 seconds |
| An agent committing something other than what it (or a human) saw | Proposal hashes: `COMMIT` must carry the exact hash, and consent grants are bound to it |
| A party preparing a proposal for someone else's agent to commit | Requester binding: only the agent whose verified proof was on the `INTENT` can commit its proposals |
| A consent approval being reused | Consent grants are scoped to `COMMIT` of one hash, one capability, one service, until expiry |
| Concurrent commits blowing through a `total` limit | Usage is reserved atomically before executing, and released on failure |
| Replayed commits | Commits are idempotent, and replays are authorized like commits |
| Replayed auto-commit frames | The proof binds the frame id, and services remember `(key, id)` beyond the proof's lifetime |
| Sub-agents exceeding their authority | Delegation can only add caveats. Unknown or malformed caveats fail closed |
| A service faking a consent request | Tooling checks the request against the proposal the agent received, re-hashes it, and shows its real effects |
| Oversized or flooding requests | 1 MiB frame limit enforced without buffering, and in-flight requests capped per connection |

## Known limits in v1

- **Services are trusted to describe their own effects.** YEA makes the description explicit and binds commits to it, but a malicious service can still lie. Signed receipts are on the roadmap.
- **No revocation.** Keep grants short-lived with `exp`.
- **`total` is counted per service.** Scope limits with `svc`.
- **`auto` proofs bind the frame id, not the params,** because floats have no canonical form. Run YEA over TLS (`yeas://`, `https://`) so frames can't be rewritten in transit.
- **The reference services keep state in memory.**

The TypeScript implementation had an adversarial security audit, and all 15 findings are fixed with regression tests. See the [design notes](/reference/design) for the details and the reasoning behind each choice.
