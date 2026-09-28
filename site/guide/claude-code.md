---
editLink: false
---

# Use it from Claude Code

<!--@include: ../../README.md#claude-code-->

## What the model gets

One tool per capability of each service (`calendar_reschedule`, `shop_order`, …), with read-only and destructive hints, plus `yea_consent`, `yea_undo` and `yea_expand`. It needs no YEA documentation: in [a real session](/reference/claude-session) (on the bridge's earlier, generic tools), Claude Sonnet 5 read Lens cold, moved a meeting within policy, stopped at a purchase over its limit, and asked the human to approve it.

## Try it without running anything

The [hosted demo](/guide/hosted-demo) runs the example calendar and shop for you, with a private copy per agent key. To wrap an API you already have, see [Wrap any REST API](/guide/openapi).
