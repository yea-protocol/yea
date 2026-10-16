# Test drive

Watch a real Claude model use YEA, live, in your terminal:

```sh
npx @yea-protocol/cli test-drive
```

::: warning Unreleased: run it from the repo
`@yea-protocol/cli` isn't on npm yet, so `npx @yea-protocol/cli` fails for now. Until it is, run the same command from a clone:

```sh
git clone https://github.com/yea-protocol/yea && cd yea
npm ci && npm run build
node cli/bin/yea.js test-drive
```
:::

It runs the example calendar and shop in-process behind the same bridge `yea mcp` serves, gives the model that bridge's tools (one per capability, such as `calendar_reschedule` and `shop_order`, plus `yea_consent`, `yea_expand` and `yea_undo`), and hands it a task. The default task: move your 1:1 with Ana to a free slot, then order four vegan meals under 700 calories.

## What you'll see

- The model's tool calls and the Lens it reads, as they happen.
- A throwaway policy: low-risk actions, up to 40.00 USD each and 100.00 USD in total, for one hour. The reschedule fits it, so it commits in one call.
- The meal order exceeds the per-action limit, so the bridge returns its proposals with a consent code each, as `yea mcp` would. Instead of asking you to run `yea approve`, the test drive's own loop shows you each proposal, with its effects and what it spends, and asks `approve this exact action? [y/N]`. Say yes and it approves the code as `yea approve` does, then tells the model to call the tool again, which commits. Say no, or run it without a terminal, and nothing is approved or charged.
- The approval happens in the test drive, never in the agent's tools: the model can't approve anything by what it sends, and the bridge signs nothing.
- The model's final report of what happened.

## Options

```sh
npx @yea-protocol/cli test-drive "book a 30-minute coffee with Sam tomorrow"   # your own task
npx @yea-protocol/cli test-drive --model claude-sonnet-5                      # another model
```

The default model is `claude-opus-5`, with server-side fallbacks if a request is refused.

## Requirements

- An Anthropic API key in `ANTHROPIC_API_KEY`, or an `ant auth login` profile.
- Node 20 or newer. The test drive lives in `@yea-protocol/mcp` (`@yea-protocol/mcp/test-drive`), and `@anthropic-ai/sdk` is an optional peer of it and of `@yea-protocol/cli`. If it isn't installed, `yea` re-runs itself once through `npx -p @yea-protocol/cli@<its version> -p @anthropic-ai/sdk@<the range it supports>` (npx asks before installing when you're at a terminal). If npx can't start, or the re-run still can't load the SDK, it stops and asks you to `npm install @anthropic-ai/sdk`. `@yea-protocol/sdk` itself has no runtime dependencies.

The test drive never touches your real keys or grants: its principal, agent and policy exist only for the session, the principal only in memory, and `YEA_HOME` and `YEA_PRINCIPAL_HOME` don't change what it does. To connect your own AI tools instead, see [Integrations](/guide/integrations).
