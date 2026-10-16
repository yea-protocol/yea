# Changelog

## v0.1.0: first public draft

YEA (*Your Explicit Approval*) was developed as Parley before its first release, and renamed to avoid clashing with other AI-agent projects.

- **Spec v1 draft:** six verbs (`HELLO`, `ASK`, `INTENT`, `COMMIT`, `UNDO`, `EXPAND`), proposals with effects, cost, risk and undo windows, policy-gated auto-commit, grants (Ed25519 capability chains) with hash-bound consent, token budgets, and Lens, the canonical model-facing text format.
- **TypeScript reference** (`@yea-protocol/sdk` on npm, with the `yea` command in `@yea-protocol/cli`): zero dependencies. Service and client, TCP/TLS/stdio/HTTP transports, the `yea` CLI, and an MCP bridge for Claude Code and other MCP clients.
- **Python implementation** (`yea-sdk` on PyPI, `import yea`): passes every conformance vector and interoperates with TS in both directions.
- **OpenAPI adapter:** `yea openapi <spec>` serves any REST API as a YEA service, with writes as previewed, consent-gated proposals.
- **One-command setup:** `yea install` registers the MCP bridge and agent instructions with Claude Code, Claude Desktop, Cursor, Windsurf, Gemini CLI, VS Code and Codex. `yea doctor` checks everything, and `yea uninstall` restores configs byte-for-byte.
- **`yea test-drive`:** watch a real Claude model use YEA live through the bridge `yea mcp` serves, approving its purchases in your terminal. It approves in its own loop, never in the agent's tools, and its throwaway principal stays in memory ([#299](https://github.com/yea-protocol/yea/issues/299)).
- **Distribution:** a Claude Code plugin (`/plugin marketplace add yea-protocol/yea`), an MCP registry entry (`io.github.yea-protocol/yea`), a Docker image (`ghcr.io/yea-protocol/yea`), and attested releases with SHA256SUMS.
- **Conformance vectors** for canonical JSON, keys, hashes, proofs, grants, Lens and token estimates.
- **Benchmark:** total input tokens against minified-JSON REST MCP across four tasks, with honest caveats. Measured on the tools `yea mcp` ships ([#297](https://github.com/yea-protocol/yea/issues/297)), YEA sends 21% more: its replies are mostly smaller, but its tool definitions are about twice REST's ([#300](https://github.com/yea-protocol/yea/issues/300) shrinks them). The first published figure, 32% fewer, counted `yea test-drive`'s 4 generic tools, which `yea mcp` doesn't serve.
- **Security:** an adversarial audit's 15 findings are fixed, with regression tests.
