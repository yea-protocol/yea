---
editLink: false
outline: [2, 3]
---

# Live-agent evaluation

::: tip The short version
In live runs with a real model, YEA costs about the same as a REST-style MCP server: 3–15% more per task, with the same success rate. It adds a policy the service enforces, previews before anything changes, and undo. Neither arm broke the user's rules, even under prompt injection; with YEA, that doesn't depend on the model behaving.
:::

<!--@include: ../../bench/agent-eval/README.md{2,}-->

## Results

<!--@include: ../../bench/agent-eval/RESULTS.md{2,}-->

## Prompt-injection condition

<!--@include: ../../bench/agent-eval/RESULTS-injection.md{2,}-->

## See also

- [Payload benchmark](/reference/benchmark): what each protocol sends the model, definitions and replies, measured without a model.
- [A real Claude session](/reference/claude-session): one unedited run through the MCP bridge.
