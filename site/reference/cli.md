---
editLink: false
---

# CLI reference

The `yea` command ships as `@yea-protocol/cli`: `npx @yea-protocol/cli <command>`, or `yea <command>` once it's installed globally (`npm i -g @yea-protocol/cli`). This is its own help text, generated from the source at build time:

<<< @/.vitepress/generated/cli-help.txt{text}

## Get started

### `yea install`

Sets YEA up for your AI tools in one step (alias: `setup`):

1. creates an agent key in `~/.yea` if there isn't one;
2. creates a principal key here **only** with `--with-principal` (or if you say yes at the prompt), warning that an agent with shell access could read it;
3. with a local principal and no grants yet, signs a starter policy: low-risk actions, up to 25.00 USD each and 100.00 USD in total, for 30 days, with anything else needing your approval;
4. registers the MCP bridge with each detected tool (or those in `--target`) and, for Claude Code, Codex, Gemini CLI and Cursor (`--local`), writes a marker-fenced `YEA` block of agent instructions.

| Flag | Meaning |
|---|---|
| `--target a,b` | Only these tools: `claude-code`, `claude-desktop`, `cursor`, `windsurf`, `vscode`, `codex`, `gemini` |
| `--local` | Write project files (`.mcp.json`, `.cursor/mcp.json`, `CLAUDE.md`, `AGENTS.md` …) instead of user-level ones |
| `--with-principal` | Also create a principal key on this machine, for trying things out. For real use, issue the grant on another device and `yea grant-import` it |

It never auto-approves YEA's tools in any client. Exactly what gets written where is on the [integrations](/guide/integrations) page.

### `yea uninstall`

Removes the bridge and the `YEA` instruction blocks from each tool (or those in `--target`). Keys and grants in `~/.yea` are left in place.

### `yea add`, `remove`, `services`

`yea add <url>` sends `HELLO` to check the service, then adds it to `~/.yea/services.json`. The bridge (`yea mcp` with no URLs) serves everything in that list. Restart your AI tool after adding.

### `yea doctor`

Checks your node version, the agent key, **whether the principal key is readable on this machine** (a warning, since agents could read it too), each grant's scope, expiry and holder, each service's reachability, and which AI tools YEA is registered with. See [Troubleshooting](/guide/troubleshooting).

## Identity and policy

`yea grant` signs a grant from the principal to the agent with these caveats:

| Flag | Caveat | Example |
|---|---|---|
| `--svc <id>` | `svc`, repeatable | `--svc cal.example.com` |
| `--can <pattern>` | `can`, repeatable | `--can "calendar.*"` |
| `--verbs A,B` | `verbs` | `--verbs ASK,INTENT` |
| `--exp <duration>` | `exp` | `--exp 24h` (`s`, `m`, `h`, `d`) |
| `--each <measure>=<max>` | `each`, a per-commit limit, repeatable | `--each spend=40.00USD` |
| `--total <measure>=<max>` | `total`, a limit over all commits, repeatable | `--total emails=20` |
| `--risk <level>` | `risk`, a ceiling | `--risk low` |
| `--to <key>` | the holder, if not your agent key | `--to ed25519:…` |

`yea grant-import <pg1.token>` saves a grant that was issued to this machine's agent key on another device, so the principal key never touches the agent's machine.

`yea delegate <token> --to <key> [caveats]` narrows a grant for a sub-agent. `yea approve <pc1.code> [--to <key>]` shows a proposal's real effects, re-checks its hash, asks for confirmation, and signs a one-time consent for it, printing it to paste back to the agent. It refuses a code that doesn't carry its proposal, since the service-written summary alone is not enough to sign. A code from `yea mcp` suggests the agent key the consent is for. It's unsigned, so unless it's this machine's own agent key, pass it with `--to` after checking its fingerprint with the agent.

## Environment

| Variable | Meaning |
|---|---|
| `YEA_HOME` | Where keys, grants and services live (default `~/.yea`) |
| `YEA_PRINCIPAL_HOME` | Where the principal key lives, if not `YEA_HOME`. Point it at another user's or device's storage |
| `YEA_TRUST` | Comma-separated principal keys that `yea examples` and `yea openapi` trust for writes (default: your own) |
| `ANTHROPIC_API_KEY` | For `yea test-drive` (or an `ant auth login` profile) |
| `YEA_TEST_DRIVE_REEXEC` | Set by `yea test-drive` on the `yea` it re-runs through npx to fetch the Anthropic SDK; that run won't re-run again |

## Try it

- `yea test-drive ["task"] [--model <id>]` runs a real Claude model (default `claude-opus-5`) against the example calendar and shop in your terminal, with a throwaway policy. Anything outside it asks you to approve. Without `@anthropic-ai/sdk` installed, it re-runs itself once through npx with `@yea-protocol/cli` at the same version and the Anthropic SDK at the range it supports; npx asks before installing when you're at a terminal. `YEA_TEST_DRIVE_REEXEC` marks that run, which stops with install advice (`npm install @anthropic-ai/sdk`) rather than re-running again, as does a failed npx. `@yea-protocol/sdk` itself has no runtime dependencies.
- `yea demo` is a narrated, scripted run with no API key needed.
- `yea examples [--port 7447] [--host 0.0.0.0]` serves the example calendar, shop and billing services (calendar on the port, shop on port + 2, billing on port + 4). Use `--host 0.0.0.0` inside containers.

See the [test drive walkthrough](/guide/test-drive) for more.

## Bridges

- `yea mcp [url …] [--tools generic|per-capability] [--budget <tokens>]`: the MCP server your AI tools run, one tool per capability (a service past 25 capabilities gets two generic tools; `--tools` forces one mode). With no URLs it serves `yea services`. It's in `@yea-protocol/cli`, not the SDK.
- `yea openapi <spec|url> [--base] [--header "K: V"] [--id] [--prefix] [--port] [--http] [--host] [--preset github|petstore]`: serve a REST API as a YEA service. See [Wrap any REST API](/guide/openapi).
