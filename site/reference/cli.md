---
editLink: false
---

# CLI reference

The `yea` command ships as `@yea-protocol/cli`: `npx @yea-protocol/cli <command>`, or `yea <command>` once it's installed globally (`npm i -g @yea-protocol/cli`).

::: warning Unreleased: run it from the repo
`@yea-protocol/cli` isn't on npm yet, so `npx @yea-protocol/cli` fails for now. Until it is, run it from a clone:

```sh
git clone https://github.com/yea-protocol/yea && cd yea
npm ci && npm run build
node cli/bin/yea.js <command>
```
:::

This is its own help text, generated from the source at build time:

<<< @/.vitepress/generated/cli-help.txt{text}

Every command has its own help: `yea <command> --help` (or `-h`, or `yea help <command>`) shows its synopsis, each flag it takes and an example. `yea --version` (or `-v`) prints the version.

A mistake on the command line says what went wrong and what to do, suggesting the closest match when there is one, then exits with status 2 before anything runs. That covers an unknown command or flag, a missing argument or one the command doesn't take, a flag without its value, and a bad value for a caveat flag (`--svc`, `--can`, `--verbs`, `--exp`, `--each`, `--total`, `--risk`), `--to` on `grant` and `delegate`, `--target`, `--preset`, a `key=value` parameter, and `yea mcp`'s `--tools` and `--budget`:

```text
$ yea grant --tx ed25519:…
yea: unknown option --tx for 'grant'
did you mean --to?
run 'yea grant --help' for usage
```

Any other error exits with status 1. Set `YEA_DEBUG=1` to see the stack trace as well.

## Get started

### `yea install`

Sets YEA up for your AI tools in one step (alias: `setup`):

1. creates an agent key in `~/.yea` if there isn't one;
2. creates a principal key here **only** with `--with-principal` (or if you say yes at the prompt), warning that an agent with shell access could read it;
3. with a local principal and no grants yet, signs a starter policy: low-risk actions, up to 25.00 USD each and 100.00 USD in total, for 30 days, with anything else needing your approval;
4. registers the MCP bridge with each detected tool (or those in `--target`) and, for Claude Code, Codex, Gemini CLI and Cursor (`--local`), writes a marker-fenced `YEA` block of agent instructions.

The bridge it registers is the `yea` that's running, with absolute paths: run from a clone, this `node` and the clone's `cli/bin/yea.js` (it refuses until the clone is built: `npm run build`); otherwise the published package through the `npx` beside this `node` (or else the first on your `PATH`). Desktop apps' own configs (Claude Desktop, Cursor, Windsurf) also get a `PATH` with `node`'s folder first, in place of the app's, since they don't start commands from your shell. Project files (`--local`, and VS Code's `.vscode/mcp.json`) get the portable `npx -y @yea-protocol/cli mcp`, so no personal path is committed.

| Flag | Meaning |
|---|---|
| `--target a,b` | Only these tools: `claude-code`, `claude-desktop`, `cursor`, `windsurf`, `vscode`, `codex`, `gemini` |
| `--local` | Write project files (`.mcp.json`, `.cursor/mcp.json`, `CLAUDE.md`, `AGENTS.md` …) instead of user-level ones |
| `--with-principal` | Also create a principal key on this machine, for trying things out. For real use, issue the grant on another device and `yea grant-import` it |
| `--require-interaction` | Write `YEA_REQUIRE_INTERACTION=1` into each entry, project files included, so Claude Code prompts for every call of a tool that changes things, even in `auto` or `bypassPermissions` ([integrations](/guide/integrations#keep-the-prompt-in-auto-or-bypass-mode)). Without it, `yea install` writes no such env, and says so when it replaces an entry that had it |
| `-y`, `--yes` | Don't ask. Without `--with-principal`, no principal key is created |

It never auto-approves YEA's tools in any client. Exactly what gets written where is on the [integrations](/guide/integrations) page.

### `yea uninstall`

Removes the bridge and the `YEA` instruction blocks from each tool (or those in `--target`; `--local` for the project's files). Keys and grants in `~/.yea` are left in place.

### `yea add`, `remove`, `services`

`yea add <url>` sends `HELLO` to check the service, then adds it to `~/.yea/services.json`. The bridge (`yea mcp` with no URLs) serves everything in that list. Restart your AI tool after adding.

### `yea doctor`

Checks what an AI tool needs to start YEA: your node version, the agent key, and each tool's registration (with `--local`, in this project's files). It starts each registered bridge the way that tool would (a desktop app without your shell's `PATH`) and checks it answers MCP's `initialize`. Any of these failing is ✗ with the command that fixes it, and makes it exit 1.

Then it reports, as warnings that say where each is fixed: a clone's build that's older than its source (after a `git pull`), **whether the principal key is readable on this machine** (agents could read it too), each grant's scope, expiry and holder, whether each service answers `HELLO` within 5 s, and the pinned principal key in `YEA_PRINCIPAL_PUB`, if that's set. Run from a clone, its advice names `yea` as `node <clone>/cli/bin/yea.js`. See [Troubleshooting](/guide/troubleshooting).

## Identity and policy

`yea grant` signs a grant from the principal to the agent, the person's [policy](/guide/policy), with these caveats:

| Flag | Caveat | Example |
|---|---|---|
| `--svc <id>` | `svc`, repeatable | `--svc cal.example.com` |
| `--can <pattern>` | `can`, repeatable | `--can "calendar.*"` |
| `--verbs A,B` | `verbs` | `--verbs ASK,INTENT` |
| `--exp <duration>` | `exp` | `--exp 24h` (`s`, `m`, `h`, `d`) |
| `--each <measure>=<max>` | `each`, a per-commit limit, repeatable | `--each spend=40.00USD` |
| `--total <measure>=<max>[/<period>]` | `total`, a limit over all commits, or per period (`s`, `m`, `h`, `d`) from 00:00 UTC today: it adds that `nbf` and needs `--exp`; repeatable | `--total emails=20`, `--total spend=500USD/7d` |
| `--risk <level>` | `risk`, a ceiling | `--risk low` |
| `--to <key>` | the holder, if not your agent key | `--to ed25519:…` |

`yea grant-import <pg1.token>` saves a grant that was issued to this machine's agent key on another device, so the principal key never touches the agent's machine.

`yea delegate <token> --to <key> [caveats]` narrows a grant for a sub-agent. `yea grant` and `yea delegate` print each `total` with a period, and the most it allows at each service before the grant expires, as `yea inspect` does. `yea approve <pc1.code> [--to <key>]` shows a proposal's real effects, re-checks its hash, asks for confirmation, and signs a one-time consent for it, printing it to paste back to the agent. It refuses a code that doesn't carry its proposal, since the service-written summary alone is not enough to sign. A code from `yea mcp` suggests the agent key the consent is for. It's unsigned, so unless it's this machine's own agent key, pass it with `--to` after checking its fingerprint with the agent.

`yea approve <id>` takes the short id a tool result gives instead of the whole code, and `yea approve` with no argument lists the pending ones, from the home's `pending/` (the bridge's) and the store's (a server's). It's a convenience for one account, where the consent is saved where the agent finds it and nothing goes back through the chat, and part of the trial setup there, since the agent could run it too ([what an approval proves](/guide/security#what-an-approval-proves)). Another OS user or device uses the whole code. Run it in a terminal outside the chat: through the agent, it has no terminal and refuses.

## Talk to a service

These take the service's URL first: `yea://host:port`, `yeas://…`, `http(s)://…/yea` or `"stdio:cmd args"`.

| Command | Does |
|---|---|
| `yea hello <url>` | Shows the service's brief: who it is and what it can do |
| `yea ask <url> <capability> [key=value …]` | Calls a read-only capability |
| `yea intent <url> <capability> [key=value …]` | Gets proposals, without acting |
| `yea commit <url> <proposal-id> <hash>` | Carries out a proposal |
| `yea undo <url> <receipt-id>` | Undoes a committed action |
| `yea expand <url> <handle>` | Fetches more of a reply that was cut to its budget |
| `yea do <url> <capability> [key=value …]` | Intent, choose, commit at the terminal, with consent prompts |

A `key=value` value that parses as JSON is JSON. Each takes `--budget <tokens>` (the default token budget for replies) and `--name <name>` (the agent name the service sees); all but `do` take `--json` to print the reply as JSON instead of Lens, and `intent` and `do` take `--goal "…"`.

## Environment

| Variable | Meaning |
|---|---|
| `YEA_HOME` | Where keys, grants and services live (default `~/.yea`) |
| `YEA_PRINCIPAL_HOME` | Where the principal key lives, if not `YEA_HOME`. Point it at another user's or device's storage |
| `YEA_TRUST` | Comma-separated principal keys that `yea examples` and `yea openapi` trust for writes (default: your own) |
| `ANTHROPIC_API_KEY` | For `yea test-drive` (or an `ant auth login` profile) |
| `YEA_DEBUG` | Set to `1` to print the stack trace with any error |
| `YEA_TEST_DRIVE_REEXEC` | Set by `yea test-drive` on the `yea` it re-runs through npx to fetch the Anthropic SDK; that run won't re-run again |

## Try it

- `yea test-drive [<task> …] [--model <id>]` runs a real Claude model (default `claude-opus-5`) against the example calendar and shop in your terminal, through the bridge `yea mcp` serves, with a throwaway policy. Anything outside it asks you, at the terminal, to approve its consent code (never without a terminal). Without `@anthropic-ai/sdk` installed, it re-runs itself once through npx with `@yea-protocol/cli` at the same version and the Anthropic SDK at the range it supports; npx asks before installing when you're at a terminal. `YEA_TEST_DRIVE_REEXEC` marks that run, which stops with install advice (`npm install @anthropic-ai/sdk`) rather than re-running again, as `yea` does when npx can't start. `@yea-protocol/sdk` itself has no runtime dependencies.
- `yea demo` is a narrated, scripted run with no API key needed.
- `yea examples [--port 7447] [--host 0.0.0.0]` serves the example calendar, shop and billing services (calendar on the port, shop on port + 2, billing on port + 4). Use `--host 0.0.0.0` inside containers.

See the [test drive walkthrough](/guide/test-drive) for more.

## Bridges

- `yea mcp [url …] [--tools generic|per-capability] [--budget <tokens>] [--name <agent name>] [--require-interaction]`: the MCP server your AI tools run, one tool per capability (a service past 25 capabilities gets two generic tools; `--tools` forces one mode). With no URLs it serves `yea services`. `--require-interaction`, or `YEA_REQUIRE_INTERACTION=1`, makes Claude Code prompt for every call of a tool that changes things, even in `auto` or `bypassPermissions` ([integrations](/guide/integrations#keep-the-prompt-in-auto-or-bypass-mode)). It's in `@yea-protocol/cli`, not the SDK.
- `yea openapi [<spec|url>] [--base] [--header "K: V"] [--id] [--prefix] [--port] [--http] [--host] [--preset github|petstore]`: serve a REST API as a YEA service. See [Wrap any REST API](/guide/openapi).
