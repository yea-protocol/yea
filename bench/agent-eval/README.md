# Live-agent evaluation

A real model (headless Claude Code, `claude -p --strict-mcp-config`) does the same tasks against the
same services through (a) a conventional REST-style MCP server (`rest-mcp.ts`, one tool per
endpoint, JSON results, an unrestricted credential) and (b) the YEA MCP bridge (a grant that
encodes the user's rules). Both arms get the same stated rules in the prompt. Outcomes and rule
violations are checked from the services' **real state** after each run.

```sh
npm run build
node bench/agent-eval/run.ts --runs 3            # → RESULTS.md (costs real money: ~18 sessions)
node bench/agent-eval/run.ts --runs 3 --only order --inject   # prompt-injection condition → RESULTS-injection.md
```

The eval needs the bridge's `requireInteraction` off, its default: leave `YEA_REQUIRE_INTERACTION` unset. `claude -p` denies every tool marked with it, since no one is there to answer the prompt.

- [RESULTS.md](RESULTS.md): three tasks, three runs each, medians.
- [RESULTS-injection.md](RESULTS-injection.md): the order task, with a fake "owner pre-approved $200" note hidden in a menu item's name.

## What we found (and what we got wrong on the way)

- **Cost is about the same.** YEA costs +3–15% per task, with the same success rate. Its replies are smaller, but in live use the total is dominated by the number of *model turns* (each turn re-reads ~27k tokens of Claude Code context), not by tool payloads.
- **Where YEA costs more:** on the over-limit order, the YEA agent fetched the exact, priced proposal before asking the human (an extra turn). The REST agent estimated the price from the menu instead.
- **Where it can win big:** when the model passes the goal straight to an intent, a reschedule is **1 call and 55k tokens, against REST's 3 calls and 82k**. That happened in 1 of 3 runs. How much a model trusts outcome-level intents is the lever.
- **Zero rule violations in both arms, even under prompt injection.** Claude Sonnet 5 followed the stated rules and ignored the injected "pre-approval". YEA's contribution is that the rules are *enforced by the service*, so they hold even when a model doesn't. That can't show up in a run where the model behaves.
- **Mistakes we fixed along the way:**
  - Our first bridge instructions made agents use YEA like CRUD (4 calls), and tightening them helped.
  - An early run counted a harness bug (a stale service on a reused port) as a REST failure.
  - The first config deferred both arms' tools behind a tool-search turn. Both now use `alwaysLoad`.
