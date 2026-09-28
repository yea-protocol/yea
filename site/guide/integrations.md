# Integrations

YEA reaches any MCP client through the bridge, `yea mcp`. One command sets it up:

```sh
npx @yea-protocol/cli install                  # detects your AI tools and configures each one
npx @yea-protocol/cli install --target cursor --local   # one tool, this project only
```

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

Every client runs the same command: `npx -y @yea-protocol/cli mcp`, optionally followed by service URLs. With no URLs, it serves the services you added with `yea add`.

::: danger Don't auto-approve destructive tools
Whatever the client, don't add tools marked `destructiveHint` (each capability that changes something, and `yea_undo`) to an auto-approve or "trusted" list. Your client's own confirmation is a second check on top of your signed policy. Auto-approving tools marked `readOnlyHint` is fine: they're reads by definition.
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

## MCP registry

YEA's MCP registry entry is `io.github.yea-protocol/yea` ([`server.json`](https://github.com/yea-protocol/yea/blob/main/server.json): npm package `@yea-protocol/cli`, stdio transport, argument `mcp`). It's published with the first release; then clients that browse the registry can install it from there.

## Services to try

```sh
yea examples               # the example calendar (7447), shop (7449) and billing (7451)
yea add yea://127.0.0.1:7447
yea add yea://127.0.0.1:7449
```

Or wrap an API you already use: [Wrap any REST API](/guide/openapi). Then restart your AI tool and ask it to do something.
