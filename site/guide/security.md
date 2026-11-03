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

## What an approval proves

An approval is only as strong as the step that produced it, judged by what the agent can reach at that step. The full threat model is in [SPEC-approval §9](https://github.com/yea-protocol/yea/blob/main/docs/framework/SPEC-approval.md#what-an-approval-proves); in short:

- **An answer to the approval form** (the form tier) proves only what the client attests, and MCP attests nothing about a person. Hooks, auto-reviewers, proxies and scripts can answer a form, and its phrase is printed in it. [Who can answer a form](/guide/integrations#who-can-answer-a-form) has what we know per client.
- **A consent signed with `yea approve`** proves the principal key signed that exact plan. It proves a person acted only when the key, and the prompt that triggers the signing, are outside everything the agent can drive. A signature triggered from inside the chat client is form tier, so no tool host signs.

Today, for servers built with the framework, a signed consent can't yet prove a person acted: it works only with the key on the server's own account, which is best effort ([today's status](https://github.com/yea-protocol/yea/blob/main/docs/framework/SPEC-approval.md#what-an-approval-proves)). The threat model also says how to put a tool's plans on the signed tier (`risk: 'high'`), and what Claude Code's call prompt would add once #338 lands.

## MCP servers built with the framework

A server that uses `@yea-protocol/mcp` ([guide](/guide/mcp-typescript)) enforces approval itself. A call through a guarded tool or job runs only if the person's signed policy allows it, the approval form came back with the plan's phrase, or a consent was signed with `yea approve`. Nothing the model passes to the tool counts as an approval. What each of those proves is [above](#what-an-approval-proves). Whether they hold depends on these; the full list is in [SPEC-approval §9](https://github.com/yea-protocol/yea/blob/main/docs/framework/SPEC-approval.md#9-security).

- **The principal's private key must be out of the agent's reach.** Whoever can use it can sign policies and consents, so an agent that can read it signs its own. Keep it on another OS user or device. On one account with an agent that can run commands, as Claude Code can, the guarantees are best effort.
- **The pinned public key must be unwritable by the server's user.** The server trusts the key in the file `YEA_PRINCIPAL_PUB` names. If the agent could change that file, it could pin a key of its own and sign with it. So the server refuses a file that its OS user owns or can write, or that sits under a directory it could change: put it somewhere like `/etc/yea/principal.pub`, written with `sudo`. It also refuses the file when it runs as root. Without a usable pinned key, nothing runs on its own and no consent is accepted, so every call asks or fails closed.
- **Only undoable plans run on their own.** A [policy](/guide/policy) can let a plan run without asking only if it has an undo window and the tool can revert it. Everything else asks every time, whatever the policy says, so anything the policy lets through can be undone. High-risk plans aren't offered in the client's approval form at all: they need `yea approve`. Undo itself also runs without asking, within its window, since it restores what was approved.
- **Approval covers calls through the tool, and nothing else.** An agent that can edit the client's config or hooks (for example, a Claude Code hook that answers the form, or rewrites the person's answer), or that can reach the resource directly with its shell, isn't stopped by it. Keep those out of the agent's reach too, or treat the protection as best effort, as with the key.

An accepted form counts only when the typed phrase matches, because some clients accept empty forms without showing them. The phrase stops a client that accepts empty forms; it doesn't stop a script or a model that reads the form. Keep the agent away from the server's store too (`~/.yea/store` by default): it holds the totals, the one-time markers and the receipts.

## Known limits in v1

- **Services are trusted to describe their own effects.** YEA makes the description explicit and binds commits to it, but a malicious service can still lie. Signed receipts are on the roadmap.
- **No revocation.** Keep grants short-lived with `exp`.
- **`total` is counted per service.** Scope limits with `svc`.
- **`auto` proofs bind the frame id, not the params,** because floats have no canonical form. Run YEA over TLS (`yeas://`, `https://`) so frames can't be rewritten in transit.
- **The reference services keep state in memory.**

The TypeScript implementation had an adversarial security audit, and all 15 findings are fixed with regression tests. See the [design notes](/reference/design) for the details and the reasoning behind each choice.
