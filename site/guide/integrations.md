# Integrations

YEA reaches any MCP client through the bridge, `yea mcp`. One command sets it up:

```sh
npx @yea-protocol/cli install                  # detects your AI tools and configures each one
npx @yea-protocol/cli install --target cursor --local   # one tool, this project only
```

::: warning Unreleased: install from a clone
`@yea-protocol/cli` isn't on npm yet, so `npx @yea-protocol/cli` fails until it's published. Until then, install from a clone: run there, `install` registers the clone itself (this `node` and `cli/bin/yea.js`) with each tool.

```sh
git clone https://github.com/yea-protocol/yea && cd yea
npm ci && npm run build
node cli/bin/yea.js install          # an agent key, the bridge (this clone) and agent instructions
node cli/bin/yea.js doctor           # starts what each tool would start, to check it
```

Add services with `node cli/bin/yea.js add <url>`, and run `npm run build` again after a `git pull`.
:::

`install` (alias: `setup`) creates an agent key and registers the bridge with each tool. For Claude Code, Codex, Gemini CLI and Cursor it also writes a short, marker-fenced `YEA` block of agent instructions, because subagents don't see MCP server instructions. Add services with `yea add <url>`; the bridge serves everything in `yea services`.

## Where your key lives

By default, `install` creates **only the agent key** on this machine. Your principal key, the one that signs your policy and approvals, belongs somewhere the agent can't read ([security model](/guide/security)). Issue the grant there and bring it over:

```sh
# on the principal's device (another OS user, machine or phone)
yea grant --to <agent key> --risk low --each spend=25.00USD --total spend=100.00USD --exp 30d

# on the agent's machine
yea grant-import <pg1.… token>
yea doctor        # "principal key is not on this machine (recommended)"
```

Just trying it out? `yea install --with-principal` creates the principal key locally, with a warning, and signs a starter policy: low-risk actions, up to 25.00 USD each and 100.00 USD in total, for 30 days. Anything else asks you. The starter policy isn't scoped to particular services, and `total` is counted per service, so the total applies at each service separately. Add `--svc` to your own grants to scope them.

## Configure by hand

The configs below run the published package, `npx -y @yea-protocol/cli mcp`, optionally followed by service URLs. With no URLs, it serves the services you added with `yea add`. That's also what `yea install` writes in project files, which others may share; elsewhere it registers the yea that ran it, with absolute paths (see the [CLI reference](/reference/cli)).

::: danger Don't auto-approve destructive tools
Whatever the client, don't add tools marked `destructiveHint` (each capability that changes something, and `yea_undo`) to an auto-approve or "trusted" list. Your client's own confirmation is a second check on top of your signed policy. Auto-approving tools marked `readOnlyHint` is fine: they're reads by definition. If you run Claude Code in `auto` or `bypassPermissions`, [keep its prompt for them](#keep-the-prompt-in-auto-or-bypass-mode).
:::

### Claude Code

As a plugin, which bundles the MCP config and a `yea` skill that teaches the model consent etiquette (it runs the npm package, so it works once `@yea-protocol/cli` 0.1.0 is published):

```text
/plugin marketplace add yea-protocol/yea
/plugin install yea@yea
```

Or register the bridge directly:

```sh
claude mcp add yea -- npx -y @yea-protocol/cli mcp
```

Or in `.mcp.json` (project) or `~/.claude.json` (user):

```json
{
  "mcpServers": {
    "yea": { "type": "stdio", "command": "npx", "args": ["-y", "@yea-protocol/cli", "mcp"], "alwaysLoad": true }
  }
}
```

`alwaysLoad` keeps the YEA tools out of Claude Code's deferred tool search, so the model sees them from the first turn.

#### Keep the prompt in auto or bypass mode

In `auto` and `bypassPermissions` mode, Claude Code runs tool calls without asking you, YEA's included. Your signed policy still decides what each service lets through, but Claude Code's own confirmation is gone. To keep it for the tools that change things, turn on `requireInteraction` (off by default):

```sh
yea install --require-interaction
```

That writes `"env": { "YEA_REQUIRE_INTERACTION": "1" }` into the entry of each tool it sets up, project files included (`--local`). Run `yea install` again without the flag to turn it off: it says so when it does. To add the server by hand instead:

```sh
claude mcp add yea -e YEA_REQUIRE_INTERACTION=1 -- npx -y @yea-protocol/cli mcp
```

In your own `.mcp.json` or `~/.claude.json`, write the value itself: `"env": { "YEA_REQUIRE_INTERACTION": "1" }`. The plugin's entry, which you don't edit, passes on the variable from the environment Claude Code starts in, so export it first:

```sh
export YEA_REQUIRE_INTERACTION=1   # in your shell profile, or before `claude`
claude
```

That's why the plugin's entry reads `"YEA_REQUIRE_INTERACTION": "${YEA_REQUIRE_INTERACTION:-}"`: Claude Code expands it from its environment, and the `:-` gives an unset variable an empty default, which is off. Without the default, an unset variable would reach the bridge as the literal `${YEA_REQUIRE_INTERACTION}`, and the bridge would refuse to start. From a shell, `yea mcp --require-interaction` does the same.

The bridge takes `1`, `true`, `0`, `false` or empty. Any other value, such as `yes`, stops it from starting, so nothing is silently left off: `claude mcp list` and `/mcp` show the server as failed, and `yea doctor` names the value. A server built with the framework takes `yea({ …, requireInteraction: true })` in TypeScript, or `yea(…, require_interaction=True)` in Python, and a single `job()` can set its own.

The tools that change things (each intent capability, and `yea_undo`; in a framework server, each job, guarded tool and `undo`) then carry `_meta["anthropic/requiresUserInteraction"]`. Reads, `yea_expand` and `yea_consent` don't. For a tool with that key, Claude Code v2.1.199 or later (v2.1.246 for the prompt without a "don't ask again" option; v2.1.292 for mods not skipping it), per the [Agent SDK permissions page](https://code.claude.com/docs/en/agent-sdk/permissions) as of 2026-11-03:

- **prompts on every call, in every mode.** There's no "don't ask again", and allow rules, `PreToolUse` hooks that return `allow`, and mods don't skip the prompt;
- **denies the call where no one can answer:** in `claude -p`, in `dontAsk` mode, and through `--permission-prompt-tool`, whose `allow` becomes a deny. So leave it off for headless runs and CI;
- **lets an Agent SDK app approve in code:** its `canUseTool` callback receives these calls and can allow them. Only in Claude Code's own interface does the prompt show that a person allowed the call.

The cost: the prompt comes on every call, including `preview: true` and calls your policy would let through without asking. That's why it's off by default. With it on, Claude Code's permission prompt, not an in-client form, is the step that shows a person allowed this call with these arguments, not which plan they approved or that the form answer is theirs (see [#337](https://github.com/yea-protocol/yea/issues/337)).

Checked in an interactive Claude Code session: pending, to be recorded with the client checks in [#326](https://github.com/yea-protocol/yea/issues/326).

### Claude Desktop

`claude_desktop_config.json`, in `~/Library/Application Support/Claude/` (macOS), `%APPDATA%\Claude\` (Windows) or `~/.config/Claude/` (Linux):

```json
{
  "mcpServers": {
    "yea": { "command": "npx", "args": ["-y", "@yea-protocol/cli", "mcp"] }
  }
}
```

### Cursor

`~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project):

```json
{
  "mcpServers": {
    "yea": { "command": "npx", "args": ["-y", "@yea-protocol/cli", "mcp"] }
  }
}
```

### VS Code (GitHub Copilot)

`.vscode/mcp.json`. Note the top-level key is `servers`:

```json
{
  "servers": {
    "yea": { "type": "stdio", "command": "npx", "args": ["-y", "@yea-protocol/cli", "mcp"] }
  }
}
```

### Codex CLI

`~/.codex/config.toml`:

```toml
[mcp_servers.yea]
command = "npx"
args = ["-y", "@yea-protocol/cli", "mcp"]
```

### Gemini CLI

`~/.gemini/settings.json` (user) or `.gemini/settings.json` (project):

```json
{
  "mcpServers": {
    "yea": { "command": "npx", "args": ["-y", "@yea-protocol/cli", "mcp"] }
  }
}
```

Leave Gemini's per-server `trust` unset or `false`: `true` skips tool-call confirmations.

### Zed

In Zed's `settings.json`:

```json
{
  "context_servers": {
    "yea": { "command": "npx", "args": ["-y", "@yea-protocol/cli", "mcp"], "env": {} }
  }
}
```

### Windsurf (Devin Desktop)

Windsurf is now Devin Desktop. Its Cascade agent reads `~/.config/devin/mcp_config.json` (older Windsurf installs: `~/.codeium/windsurf/mcp_config.json`); open it from the Cascade panel's **…** menu, **MCPs**, **Open MCP config file**. `yea install` writes whichever applies.

```json
{
  "mcpServers": {
    "yea": { "command": "npx", "args": ["-y", "@yea-protocol/cli", "mcp"] }
  }
}
```

### Hermes Agent

[Hermes Agent](https://github.com/NousResearch/hermes-agent) is an MCP client, so it can use YEA services directly:

```sh
hermes mcp add yea --command npx --args -y @yea-protocol/cli mcp
```

or in Hermes's `config.yaml`:

```yaml
mcp_servers:
  yea:
    command: "npx"
    args: ["-y", "@yea-protocol/cli", "mcp"]
```

When a commit needs the human's approval, the tool returns a consent code for `yea approve`, and the agent hands the signed consent back through `yea_consent`. If you restrict which tools a server exposes (`tools.include`), keep `yea_consent`, `yea_undo` and `yea_expand` alongside the capability tools you want.

## Servers built with the framework

A server built with [`@yea-protocol/mcp`](/guide/mcp-typescript) or [`yea-mcp`](/guide/mcp-python) doesn't go through the bridge: it's an ordinary MCP server, and you register it with each client the way you register any other. What YEA adds is in its environment and in the client's support for forms.

- **Its environment:** whatever the server itself needs (the guides' `files` example needs `FILES_ROOT`, the folder its tools may change, and refuses to start without it), plus YEA's: `YEA_PRINCIPAL_PUB`, the path of a file holding the pinned principal public key (one the server's user can't change), and `YEA_POLICY`, the signed policy (a `pg1.` token, or the absolute path of a file holding one). Without `YEA_POLICY` every job asks; without `YEA_PRINCIPAL_PUB` no consent code is issued either, so only clients with forms can approve. Client config files don't expand `~`, so use full paths.
- **Approval in the client:** a client with MCP form elicitation shows the plan and a field to type the phrase. A client without it gets a consent code, and the person runs `yea approve <code>`. The [client table](https://github.com/yea-protocol/yea#client-support) says which clients we've run, and [Client runs](#client-runs) shows how.

For example, in **Claude Code**:

```sh
claude mcp add files \
  -e FILES_ROOT=/Users/me/yea-scratch \
  -e YEA_PRINCIPAL_PUB=/etc/yea/principal.pub \
  -e YEA_POLICY=/Users/me/.config/yea/files.policy \
  -- uv run python server.py                          # or: npx tsx server.ts
```

In **Cursor** (`.cursor/mcp.json`) and other clients that use an `mcpServers` object, put the same variables in the server's `env`:

```json
{
  "mcpServers": {
    "files": {
      "command": "uv",
      "args": ["run", "--directory", "/absolute/path/to/project", "python", "server.py"],
      "env": {
        "FILES_ROOT": "/Users/me/yea-scratch",
        "YEA_PRINCIPAL_PUB": "/etc/yea/principal.pub",
        "YEA_POLICY": "/Users/me/.config/yea/files.policy"
      }
    }
  }
}
```

VS Code (`.vscode/mcp.json`) uses a top-level `servers` key with the same fields, plus `"type": "stdio"`. The server prints its id on stderr at start-up (`yea: service id ed25519:… (name files)`), which is what `yea grant --to` needs. Each guide's step 5 walks through the whole setup.

## Client runs

The evidence behind the [client table](https://github.com/yea-protocol/yea#client-support). A run counts for "asks in the client" only if it's interactive and the client draws the form. `claude -p` cancels a form (Claude Code's docs), and Codex under `approval_policy = "never"` rejects one (its config reference). The tool then reports "not approved", just as if a person had declined, so a transcript where no dialog was drawn proves nothing about the form. What `codex exec` does with a form, and whether its automatic review can answer one, is on the [checklist on #319](https://github.com/yea-protocol/yea/issues/319#issuecomment-6607457641).

A form that reaches a person is one check, not proof that only a person can answer it: the phrase is in the request, and some clients let software answer forms ([#337](https://github.com/yea-protocol/yea/issues/337)). So each run names what in that client can answer a form without a person.

### Claude Code, 2026-11-03

| | |
|---|---|
| Client | Claude Code 2.1.317, interactive, in tmux 3.6a on macOS 26.6.2, in auto permission mode |
| Runtimes | both: `MCP_SDK_GENERATION=v2` negotiated revision 2026-07-28 (`input_required`, state sealed in `requestState`); `MCP_SDK_GENERATION=v1` negotiated 2025-11-25 (`elicitation/create`). Claude Code declared `elicitation: {form: {}, url: {}}` on both |
| Repo | commit `8719326`; `@yea-protocol/mcp` 0.1.0, `@modelcontextprotocol/server` 2.3.1, zod 4.6.7, Node 22.18.0 |
| Server | [`examples/mcp-quickstart.ts`](https://github.com/yea-protocol/yea/blob/main/examples/mcp-quickstart.ts)'s `createServer`, started by a launcher that logs the negotiated revision, behind a proxy that logs every JSON-RPC line and the server's stderr |
| Registered with | `claude --strict-mcp-config --mcp-config <file>`, so nothing was written to the Claude Code MCP config |
| Answers a form without a person | an [`Elicitation` hook](https://code.claude.com/docs/en/hooks#elicitation), which answers with no dialog drawn. None was configured for these runs |

What happened (the same on both runtimes unless a bullet says otherwise):

- **The form.** Claude Code drew *MCP server "files" requests your input*, the first two lines of the message (`Approval needed: delete_file can't be undone.` and `[1] Delete docs/report.pdf`), and a *Confirm* field described as `Type "report.pdf" to approve.`. The rest of the message (the effect, `risk: medium · undo: never` and the phrase line) was folded behind *… (+3 more lines)*.
- **Wrong phrases.** We typed `notes.txt`, `notes.txt`, then `report`. The server asked again after each of the first two (`Approval needed: type "report.pdf" exactly to approve.`). After the third it returned `✗ not approved after 3 tries; nothing was run`, and the file was still there.
- **The right phrase.** `report.pdf` deleted the file, and the result carried a receipt.
- **Consent codes.** With `{ "outOfBand": "medium" }` in the server's `policy.json` (a medium-risk plan is never approved in the chat) and a pinned principal key, the call returned `✗ approval needed: risk is medium, which needs approval outside the chat; nothing was run` and a `pc1.` code. In a second tmux pane, `yea approve <code>` showed the plan. In the v2 run, a wrong phrase printed `not approved` and exited 1 (the v1 run typed only the right phrase); `report.pdf` printed `✓ approved`. The same call then ran once.
- **Where to run `yea approve`.** Claude Code suggested typing `! yea approve …` in the chat. A `!` command has no terminal, so `yea approve` refuses it (`approval needs an interactive terminal`): run it in a separate terminal, as we did.
- **Claude Code's own prompt.** Its permission prompt for the tool call never appeared: auto mode allowed every call (*Allowed by auto mode*). The form appeared anyway, because the server asks, not the client ([#338](https://github.com/yea-protocol/yea/issues/338)).

Two things differ from the guide's setup. The launcher passes the principal key as `yea()`'s `principal` option rather than through `YEA_PRINCIPAL_PUB`: the pinned file must be one the server's OS user can't change, and the run had no root access to make one. And `yea approve` ran with `YEA_HOME` set to the folder holding the principal key, and `YEA_STORE` set to the server's store.

[Transcripts](https://github.com/yea-protocol/yea/tree/main/docs/client-runs/2026-11-03-claude-code): every keystroke, the screens (`tmux capture-pane`), and the wire log with the server's stderr, for each of the four runs (form and codes, on each runtime), with the launcher and proxy to reproduce them.

### Codex and Gemini CLI

Not run by us yet (2026-11-03): each needs a vendor sign-in and model credit, so a person runs them from the [checklist on #319](https://github.com/yea-protocol/yea/issues/319#issuecomment-6607457641).

Gemini CLI can't show the form. Version 0.66.0's MCP client registers only the `roots` capability (`connectToMcpServer` in its bundle), so the framework gives it consent codes. Its tracker agrees: [#28074](https://github.com/google-gemini/gemini-cli/issues/28074) (no elicitation capability) was closed as not planned, the pull request implementing it ([#28089](https://github.com/google-gemini/gemini-cli/pull/28089)) closed unmerged, and [#22249](https://github.com/google-gemini/gemini-cli/issues/22249) reports *Method not found* with elicitation tools.

Codex documents form elicitation, and its `approval_policy` decides whether a form reaches the person. Under `never`, the setting its reference gives for non-interactive runs, Codex never asks, so a form is rejected. Under `granular`, a form is rejected unless `mcp_elicitations = true`. Its reference also says `approvals_reviewer = "auto_review"` hands eligible approval prompts to a reviewer subagent; whether a form counts as one isn't stated there, only in third-party write-ups.

### Claude Desktop, Cursor, VS Code and Windsurf

These need a person at a GUI; their [checklist is on #319](https://github.com/yea-protocol/yea/issues/319#issuecomment-6607457641).

## MCP registry

YEA's MCP registry entry is `io.github.yea-protocol/yea` ([`server.json`](https://github.com/yea-protocol/yea/blob/main/server.json): npm package `@yea-protocol/cli`, stdio transport, argument `mcp`). It's published with the first release; then clients that browse the registry can install it from there.

## Services to try

```sh
yea examples               # the example calendar (7447), shop (7449) and billing (7451)
yea add yea://127.0.0.1:7447
yea add yea://127.0.0.1:7449
```

Or wrap an API you already use: [Wrap any REST API](/guide/openapi). Then restart your AI tool and ask it to do something.
