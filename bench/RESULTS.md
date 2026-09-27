# YEA vs REST-style MCP — token benchmark

Tokenizer: o200k_base (gpt-tokenizer). Claude's tokenizer differs; the ratios are what matter. Both sides serve the same data. Ids are seeded, so runs are reproducible.

**Total input** counts what you pay for: each model turn re-reads the tool definitions plus the conversation so far (calls and results), and there's one final turn to answer.

Tool definitions in context every turn: REST MCP **761** tokens (11 tools) vs YEA **687** (4 generic tools + service briefs).

| Task | Calls (REST → YEA) | Total input: REST minified JSON | REST pretty JSON | YEA | Saved vs minified | vs pretty |
|---|---|---|---|---|---|---|
| Reschedule a meeting (REST: search → free slots → update) | 3 → 1 | 3,807 | 3,962 | 1,548 | **59%** | 61% |
| Reschedule a meeting (REST: one outcome-level endpoint) | 1 → 1 | 1,609 | 1,630 | 1,548 | **4%** | 5% |
| Find vegan meals < 700 kcal and order four | 2 → 2 | 3,176 | 3,638 | 2,710 | **15%** | 26% |
| Read the full 60-item menu | 1 → 1 | 3,452 | 4,552 | 2,495 | **28%** | 45% |
| Skim the menu (first 30 items: REST limit=30, YEA budget=800) | 1 → 1 | 2,467 | 3,027 | 1,961 | **21%** | 35% |
| **All tasks** (CRUD reschedule row) | | 12,902 | 15,179 | 8,714 | **32%** | 43% |

Result tokens read, per task (minified REST → YEA): 316 → 129 · 62 → 129 · 462 → 310 · 1919 → 1095 · 932 → 558

## What the model actually reads

### Reschedule, REST CRUD (3 calls, pretty JSON)

```json
[
  {
    "id": "e2",
    "title": "1:1 with Ana",
    "start": "2026-09-28T14:00:00Z",
    "end": "2026-09-28T14:30:00Z",
    "attendees": [
      "ana.ruiz@acme.co"
    ]
  }
]

{
  "day": "2026-09-30",
  "slots": [
    "2026-09-30T09:30:00Z",
    "2026-09-30T10:00:00Z",
    "2026-09-30T10:30:00Z",
    "2026-09-30T11:00:00Z",
    "2026-09-30T11:30:00Z",
    "2026-09-30T12:00:00Z",
    "2026-09-30T12:30:00Z",
    "2026-09-30T15:00:00Z",
    "2026-09-30T15:30:00Z",
    "2026-09-30T16:00:00Z",
    "2026-09-30T16:30:00Z",
    "2026-09-30T17:00:00Z",
    "2026-09-30T17:30:00Z"
  ]
}

{
  "id": "e2",
  "title": "1:1 with Ana",
  "start": "2026-09-30T09:30:00Z",
  "end": "2026-09-30T10:00:00Z",
  "attendees": [
    "ana.ruiz@acme.co"
  ],
  "updated": true
}
```

### Reschedule, YEA (1 call, auto-commit)

```
✓ Move "1:1 with Ana" to 2026-09-30T09:30:00Z (receipt r_Fgb6EIWi) · undo until 2026-09-28T20:36:29Z
  ~ update event/e2.start: 2026-09-28T14:00:00Z → 2026-09-30T09:30:00Z
  > send ana.ruiz@acme.co — updated invite
  result:
    event: e2
    start: 2026-09-30T09:30:00Z
```

What the tokens don't show: the YEA agent acted only because the principal's grant allows low-risk, undoable changes, and it got back exactly what happened with a 24h undo window. In the auto-commit case the *service* chose the slot (the first free one), just like the REST outcome endpoint. An agent that wants to choose omits `auto` and gets three proposals instead.
