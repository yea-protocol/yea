# @yea-protocol/cli

**The `yea` command for [YEA](https://github.com/yea-protocol/yea)** (*Your Explicit
Approval*), the open protocol for AI agents acting on behalf of people. It runs the demo, sets YEA
up for your AI tools through an MCP bridge (`yea mcp`), signs the person's policy (`yea grant`),
and approves one plan at a time with a consent the person signs in their terminal, outside the
chat (`yea approve`). What a signed consent proves depends on where the key lives
([what an approval proves](https://github.com/yea-protocol/yea/blob/main/docs/framework/SPEC-approval.md#what-an-approval-proves)).

```sh
npm i -g @yea-protocol/cli
```

> **Unreleased:** `@yea-protocol/cli` isn't on npm yet, so this install fails for now. Until
> the release, build a clone and run `node cli/bin/yea.js` there in place of `yea`:
>
> ```sh
> git clone https://github.com/yea-protocol/yea && cd yea
> npm ci && npm run build
> ```

<!-- snippet: examples/cli-quickstart.sh#quickstart -->
```sh
yea demo      # a narrated session: two services, consent, undo and sub-agents. No API key.
yea install   # set YEA up for the AI tools it finds: an agent key and the MCP bridge
yea doctor    # check keys, grants and services, and that your AI tools start YEA
```

`yea install` looks for Claude Code, Cursor, Codex, Gemini CLI, VS Code, Windsurf and Claude
Desktop, or sets up the ones you name with `--target`. The agent can read but not act until the
person signs it a policy with `yea grant` where their key lives, which `yea doctor` walks through.
`yea test-drive` watches a real Claude model use YEA's tools, with an Anthropic API key.
`yea --help` lists every command, and `yea help <command>` shows its flags and an example.

## Next

- **The guide**, [Integrations](https://yea-protocol.github.io/yea/guide/integrations), sets up
  each AI tool; the [CLI reference](https://yea-protocol.github.io/yea/reference/cli) lists every
  command.
- **The spec** is [SPEC.md](https://github.com/yea-protocol/yea/blob/main/SPEC.md), the protocol,
  and [SPEC-bridge.md](https://github.com/yea-protocol/yea/blob/main/docs/framework/SPEC-bridge.md)
  for `yea mcp`.
- **The library** behind it is [`@yea-protocol/sdk`](https://www.npmjs.com/package/@yea-protocol/sdk).

## License

Apache-2.0
