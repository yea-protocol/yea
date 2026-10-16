# YEA vs REST-style MCP — token benchmark

Tokenizer: o200k_base (gpt-tokenizer). Claude's tokenizer differs; the ratios are what matter. Both sides serve the same data. Ids are seeded and the clock is fixed, so runs are reproducible.

**Total input** counts what you pay for: each model turn re-reads the tool definitions plus the conversation so far (calls and results), and there's one final turn to answer.

Tool definitions in context every turn: REST MCP **761** tokens (11 tools) vs YEA **1,466** (`yea mcp`'s 12 tools: 9 per capability, plus yea_consent, yea_expand, yea_undo; and its instructions).

| Task | Calls (REST → YEA) | Total input: REST minified JSON | REST pretty JSON | YEA | Saved vs minified | vs pretty |
|---|---|---|---|---|---|---|
| Reschedule a meeting (REST: search → free slots → update) | 3 → 1 | 3,807 | 3,962 | 3,086 | **19%** | 22% |
| Reschedule a meeting (REST: one outcome-level endpoint) | 1 → 1 | 1,609 | 1,630 | 3,086 | **-92%** | -89% |
| Find vegan meals < 700 kcal and order four | 2 → 2 | 3,176 | 3,638 | 4,994 | **-57%** | -37% |
| Read the full 60-item menu | 1 → 1 | 3,452 | 4,552 | 4,037 | **-17%** | 11% |
| Skim the menu (first 30 items: REST limit=30, YEA on a second bridge at --budget 800) | 1 → 1 | 2,467 | 3,027 | 3,520 | **-43%** | -16% |
| **All tasks** (CRUD reschedule row) | | 12,902 | 15,179 | 15,637 | **-21%** | -3% |

Result tokens read, per task (minified REST → YEA): 316 → 129 · 62 → 129 · 462 → 309 · 1919 → 1095 · 932 → 578

## What changed, and why the numbers moved

Until #297 this benchmark counted YEA's side as `yea test-drive`'s 4 generic tools, its instructions and two HELLO briefs (**687** tokens of definitions), with each service's own Lens as results. No `yea mcp` user gets that surface. It now connects an MCP client to `bridge()` from `@yea-protocol/mcp/bridge` in-process, with `yea mcp`'s default options, and counts what the bridge sends: `tools/list` and its instructions as definitions, and each tool call's text as results. The definitions grew from 687 to **1,466** tokens, and they're re-read every turn, so over all tasks YEA went from 32% fewer tokens than minified-JSON REST to **21% more**. Shrinking the bridge's definitions is [#300](https://github.com/yea-protocol/yea/issues/300).

- Definitions count each tool's `name`, `description` and `inputSchema`, the fields a model API takes and the ones the REST side has. All of `tools/list`, with `annotations` and `_meta`, is **1,906** tokens.
- Results count each call's text content. The `structuredContent` beside it is another **3,122** tokens over the counted tasks. Counting all of `tools/list` and `structuredContent` too, YEA's all-tasks total is **23,032**, 79% more than minified-JSON REST.
- The skim row runs on a second bridge started with `budget: 800` (`yea mcp --budget 800`): at the default 1500 the whole menu fits in one reply, and the bridge's tools take no budget.

## What the model actually reads

### Reschedule, REST CRUD (3 calls, pretty JSON)

```json
[
  {
    "id": "e2",
    "title": "1:1 with Ana",
    "start": "2026-10-16T14:00:00Z",
    "end": "2026-10-16T14:30:00Z",
    "attendees": [
      "ana.ruiz@acme.co"
    ]
  }
]

{
  "day": "2026-10-18",
  "slots": [
    "2026-10-18T09:30:00Z",
    "2026-10-18T10:00:00Z",
    "2026-10-18T10:30:00Z",
    "2026-10-18T11:00:00Z",
    "2026-10-18T11:30:00Z",
    "2026-10-18T12:00:00Z",
    "2026-10-18T12:30:00Z",
    "2026-10-18T15:00:00Z",
    "2026-10-18T15:30:00Z",
    "2026-10-18T16:00:00Z",
    "2026-10-18T16:30:00Z",
    "2026-10-18T17:00:00Z",
    "2026-10-18T17:30:00Z"
  ]
}

{
  "id": "e2",
  "title": "1:1 with Ana",
  "start": "2026-10-18T09:30:00Z",
  "end": "2026-10-18T10:00:00Z",
  "attendees": [
    "ana.ruiz@acme.co"
  ],
  "updated": true
}
```

### Reschedule, YEA (1 call through the bridge, auto-commit)

```
✓ Move "1:1 with Ana" to 2026-10-18T09:30:00Z (receipt r_EK8NhoqT) · undo until 2026-10-16T08:00Z
  ~ update event/e2.start: 2026-10-16T14:00:00Z → 2026-10-18T09:30:00Z
  > send ana.ruiz@acme.co — updated invite
  result:
    event: e2
    start: 2026-10-18T09:30:00Z
```

What the tokens don't show: the YEA agent acted only because the principal's grant allows low-risk, undoable changes, and it got back exactly what happened with a 24h undo window. In the auto-commit case the *service* chose the slot (the first free one), just like the REST outcome endpoint. An agent that wants to choose calls with `preview: true`, gets three proposals, and commits one with `proposal`.
