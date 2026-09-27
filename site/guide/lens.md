# Lens

Models read text. Lens is a canonical, deterministic, compact text rendering of every YEA reply and of any JSON value. Clients show the model the Lens instead of raw JSON. It's specified to the byte, and both implementations must produce identical output for the same input ([SPEC §9](/reference/spec#9-lens--the-models-view)).

## What it looks like

```
2 proposals — risk: low · undo: 2h · expires: 2026-09-24T02:22Z:
[p_71KbTFLA] 4 meals for 2026-09-26 — 53.95 USD
  + create order/o1001 — 2× Tofu Pad Thai (light), 2× Chickpea Shawarma (light)
  + create charge — 53.95 USD to card ••4242
  uses: spend 53.95 USD
[p_JU6-iYhB] 4 meals for 2026-09-26 (express, by noon) — 62.94 USD
  …
```

- **Effect lines** use one-character operators: `+` create, `~` update, `-` delete, `>` send, `*` other.
- **Uniform lists become tables** that name their keys once: `items[60]{sku,name,usd,cal,protein}:` and then one row per item.
- **Strings are bare** when that's unambiguous, and quoted otherwise.
- **Shared attributes** of several proposals appear once, in the header.
- **Receipts** are one line plus the result, because the model already read the effects in the proposal (unless the service auto-committed, in which case the effects are shown).
- **Errors** carry their fixes: `fix: rename `dya` to `day` → params {"dya":null,"day":"2026-09-25"}`.

## Why specify it

1. **Compactness where it counts.** The 60-item menu costs 1,095 tokens in Lens against 1,919 in minified JSON and 3,019 pretty-printed.
2. **Consistency across services.** A model that has read one YEA receipt can read them all.
3. **Budgets that mean something.** A budget constrains the text the model actually reads.

Lens is designed to be read cold. In [a real session](/reference/claude-session), a model with no YEA documentation read it correctly on the first try.
