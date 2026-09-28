# Test drive

Watch a real Claude model use YEA, live, in your terminal:

```sh
npx @yea-protocol/cli test-drive
```

It runs the example calendar and shop in-process, gives the model four generic tools (`yea_ask`, `yea_intent`, `yea_commit`, `yea_undo`), and hands it a task. The default task: move your 1:1 with Ana to a free slot, then order four vegan meals under 700 calories.

## What you'll see

- The model's tool calls and the Lens it reads, as they happen.
- A throwaway policy: low-risk actions, up to 40.00 USD each and 100.00 USD in total, for one hour. The reschedule fits it, so it can commit in one round trip if the model uses `auto`.
- The meal order exceeds the per-action limit, so the service replies `consent_required` and **you** are asked to approve it at the terminal, after seeing its effects and what it spends. Say no and nothing is charged.
- The model's final report of what happened.

## Options

```sh
npx @yea-protocol/cli test-drive "book a 30-minute coffee with Sam tomorrow"   # your own task
npx @yea-protocol/cli test-drive --model claude-sonnet-5                      # another model
```

The default model is `claude-opus-5`, with server-side fallbacks if a request is refused.

## Requirements

- An Anthropic API key in `ANTHROPIC_API_KEY`, or an `ant auth login` profile.
- Node 20 or newer. If `@anthropic-ai/sdk` isn't installed, `yea` re-runs itself once through `npx -p @yea-protocol/cli@<its version> -p @anthropic-ai/sdk`; if that run still can't load it, it stops and asks you to `npm install @anthropic-ai/sdk`. The SDK itself (`@yea-protocol/sdk`) has no runtime dependencies.

The test drive never touches your real keys or grants: its principal, agent and policy exist only for the session. To connect your own AI tools instead, see [Integrations](/guide/integrations).
