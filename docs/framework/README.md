# YEA framework v0

YEA is the protocol. The product people adopt is a set of plugins for the **official MCP
SDKs**. With them, an MCP server's risky tools return a previewed plan: its effects, what it uses,
risk and undo window. A plan runs only with a person's explicit approval, or within that person's
policy, and it can be undone afterwards. Adoption is incremental, one tool at a time.

This page is the capability map for Framework v0 ([#35](https://github.com/yea-protocol/yea/issues/35)).
Each module gets its own spec in this folder, named `SPEC-<module id>.md`. The table below is
the index of what exists.

## Modules

| Module id | Responsibility | Depends on | Owner |
|---|---|---|---|
| `approval` | [SPEC-approval.md](SPEC-approval.md). The approval contract, independent of language. It covers how a plan is shown and how approval is asked for (an MRTR elicitation with a typed confirmation). It also covers how an approval binds to a plan's hash, re-checked on commit, and that approvals are consumed once. It covers policy auto-approve, failing closed when the client can't elicit, undo, and a pluggable store for consumed approvals, receipts and the usage ledger. It's implemented in the SDK core in TypeScript and Python, with conformance vectors. | existing SDK core | parley-80 (TS), parley-05 (Python) |
| `mcp-ts` | `@yea-protocol/mcp`, a plugin for the TypeScript SDK v2 (`@modelcontextprotocol/server`). It registers job tools, or wraps an existing tool. [SPEC-mcp-ts.md](SPEC-mcp-ts.md) | `approval` | parley-80 |
| `mcp-py` | `yea-mcp`, a plugin for the official `mcp` 2.x (`MCPServer`, `Extension.intercept_tool_call`), with a FastMCP 4 middleware adapter. [SPEC-mcp-py.md](SPEC-mcp-py.md) | `approval` | parley-05 |
| `bridge` | Moves `yea mcp`, which was written against the 2025 protocol, onto `mcp-ts`, so there is one MCP implementation that speaks 2026-07-28. [SPEC-bridge.md](SPEC-bridge.md) | `mcp-ts` | parley-80 |
| `connector-stripe` | `@yea-protocol/stripe`, the first ready-made connector, built from `examples/stripe-billing.ts`, plus a measured comparison with Stripe's official MCP server. [SPEC-connector-stripe.md](SPEC-connector-stripe.md) | `mcp-ts` | parley-80 |
| `docs` | Guides for adding YEA to an MCP server in TypeScript and Python, the site pages, and a repositioned README. | `mcp-ts`, `mcp-py` | both |

**Build order:** `approval`, then `mcp-ts` and `mcp-py` in parallel, then `bridge`,
`connector-stripe` and `docs`. Python already has a per-tool interception hook, while
TypeScript v2 is waiting on [PR #2820](https://github.com/modelcontextprotocol/typescript-sdk/pull/2820),
so `mcp-py` may be the first end-to-end proof.

**Not in v0:** more connectors, re-hosting the OpenAPI adapter on the framework, and a
proposal to the MCP spec. Align with SEP-2793 first.

## Decisions

- **One tool per job.** Tools are named for what they do, such as `refund` or `cancel`, not
  catch-all tools, which MCP practice discourages. If the person's policy allows the action,
  the call runs and returns a receipt. If not, the same call returns an approval request that
  shows the plans. The person picks one and confirms, then the call completes. A generic
  `undo(receipt)` tool reverses what can be reversed, and `preview: true` returns plans
  without acting.
- **Current SDK lines only:** TypeScript SDK v2, Python `mcp` 2.x first, then a FastMCP 4
  adapter.
- **Approval is enforced by the server and fails closed.** Clients that can't elicit (Claude
  Desktop, Gemini CLI) run only what the policy allows. Anything else needs out-of-band
  approval (`yea approve <code>`). The model can never approve on a person's behalf.
- **An accept alone isn't trusted.** Approval forms require a typed confirmation, because some
  clients auto-accept empty forms.
- **Policy is signed by the person.** It decides what runs without asking: which tools, up to
  what risk (only undoable plans ever run without asking), and `each`/`total` limits on
  anything a plan uses (money, emails, deletions). Anything that loosens it is a grant signed
  with the principal key; unsigned local config can only tighten it.
- **The protocol stays.** SPEC.md and the wire format don't change. The framework maps YEA's
  verbs onto MCP.

## What the design rests on (checked 2026-09-26)

- **MCP 2026-07-28 is stateless** ([changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)).
  Servers can't send requests to clients. Elicitation is a round trip (MRTR, SEP-2322): the
  tool returns `input_required` with a `requestState`, and the client retries with the answers.
  Servers must treat `requestState` as attacker-controlled. Sampling is deprecated.
- **SDKs:**
  - TypeScript v2 (`@modelcontextprotocol/server` 2.1.0) is the stable line. Its legacy shim
    serves 2025-era clients.
  - Python `mcp` 2.2.0 renamed its FastMCP to `MCPServer`. It seals `requestState` with
    AES-256-GCM and offers `Extension.intercept_tool_call`.
  - `fastmcp` 4 builds on `mcp` 2 and has `Middleware.on_call_tool`.
- **Elicitation by client:**
  - Supported: Claude Code, Cursor, VS Code and Codex.
  - Not supported: Claude Desktop, claude.ai and Gemini CLI.
  - Unknown: Windsurf and ChatGPT.
  - Codex auto-accepts elicitations with no fields under auto-approve policies.
- **Nothing accepted in MCP covers preview, dry-run or undo.** The closest open proposal is
  SEP-2793 (Tool Risk Metadata). The nearest library is
  [mcp-approval](https://github.com/ni-c/mcp-approval), which adds approval prompts only: no
  plans, limits, undo or Python.

Full notes and sources: [#35](https://github.com/yea-protocol/yea/issues/35#issuecomment-5848005093).
