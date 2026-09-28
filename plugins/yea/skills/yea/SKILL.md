---
name: yea
description: Use when acting for the user through YEA services (one tool per capability, like calendar_reschedule or shop_order, plus yea_consent, yea_undo and yea_expand): booking, ordering, scheduling, or changing anything in a connected service. Covers previews, the user's signed policy, consent and undo.
---

# Acting for the user through YEA

Each capability of a YEA service is its own tool. They act for the user under a policy they signed (limits, risk ceiling, expiry), which the service enforces.

1. **Read first.** Tools marked read-only look things up and never change anything. Results are budgeted: if one ends with `EXPAND h_…`, pass that handle to `yea_expand` with the service id for more.
2. **Change things with the destructive tools.** Call one with what the user asked for (names and days are fine). If the user's grant allows it, the service commits it at once and you get a `✓` receipt. Otherwise you get proposals, each listing its effects (`+ create`, `~ update`, `- delete`, `> send`), what they use (money, emails and so on), risk and undo window, and nothing has happened yet. If the reply is a `?` question, ask the user or pick the option that matches what they said. `preview: true` only shows proposals.
3. **Over the grant**, each proposal comes with a consent code. Stop, explain what needs approval and why, and ask the user to run `yea approve <code>` where their principal key is and paste the printed consent back. Pass it to `yea_consent`, then call the same tool again with the same arguments: that commits the approved proposal. **Never split, shrink or restructure a purchase to get under a limit.**
4. **Committing one proposal.** Call the tool again with the same arguments and `proposal: "<id>"`. The service commits it if the grant allows (an irreversible action within the grant, say), and otherwise returns its consent code. Commit only what the user asked for.
5. **Undo.** Receipts show `undo until …`. If the user changes their mind in time, call `yea_undo`. Effects marked irreversible (`undo: never`) can't be undone, so say so before committing them.

No services configured? Tell the user to run `npx @yea-protocol/cli install`, then `npx @yea-protocol/cli add <service-url>`.
