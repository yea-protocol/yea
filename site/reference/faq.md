# FAQ

## Isn't this just MCP?

No. MCP standardizes how a model finds and calls tools. YEA standardizes what the tool is: an outcome-level interface with previews, undo, delegated authority, budgets and a model-native format. They compose: the YEA bridge serves YEA services over MCP, so any MCP client can use them today. See [Use it from Claude Code](/guide/claude-code).

## Why a new protocol instead of HTTP conventions?

Previews, consent bound to hashes, capability grants, budgets and Lens have to hold across every service to be worth anything to an agent. Conventions layered on HTTP get adopted piecemeal and implemented differently by every API, and a preview header only some APIs honor is worse than none, because the agent can't rely on it. YEA still rides HTTP through its bridge where infrastructure requires it; its semantics just don't depend on it. More in the [design notes](/reference/design#a-protocol-not-conventions-on-http).

## Does the model need to learn a new format?

No. Lens is designed to be read cold: tables for uniform lists, `~ update` and `> send` effect lines, and what each proposal uses and how long it can be undone. In [a real session](/reference/claude-session), Claude read it correctly with no YEA documentation at all.

## Does it cost more to use?

About the same. In [live runs](/benchmark/live) with Claude Sonnet 5 in headless Claude Code, YEA cost 3–15% more per task than a REST-style MCP server, with the same success rate. YEA's replies are 30–45% smaller than JSON ([payload benchmark](/reference/benchmark)), but a live session's cost is dominated by the model re-reading its context every turn, so that doesn't lower the bill on its own. What you get for the difference is a policy the service enforces, previews and undo.

## Why not JWT or OAuth for delegation?

They answer "who is this?" Agents need "what exactly may this do, for whom, up to how much, until when, and can it hand a narrower slice to a helper?" That's a capability chain, in the lineage of macaroons and Biscuit, with caveats any service can check offline. More in [Grants and consent](/guide/grants).

## Can the agent approve its own purchases?

Not if the principal key is where it belongs. The protocol binds consent to one exact proposal, and the bridge never approves on the model's behalf, but anyone holding the principal key can sign. Read the [security model](/guide/security).

## Is it production-ready?

Not yet. It's a v1 draft with two conformant implementations, a shared conformance suite, and an adversarial security audit whose findings are all fixed. Before 1.0: revocation lists, multi-party atomic commits, and a QUIC transport. Feedback on the [spec](/reference/spec) is the most valuable contribution right now.

## What's the license?

Apache-2.0. The spec is free to implement, and the [conformance vectors](https://github.com/yea-protocol/yea/tree/main/conformance) are the contract.
