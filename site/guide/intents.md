# Intents and proposals

REST gives an agent resources to create, read, update and delete. YEA gives it a different loop: say what you want, see exactly what would happen, then decide.

```
agent ──INTENT "move my 1:1 with Ana to Thursday"──────▶ service
      ◀─PROPOSALS [p1] ~ event/e2.start 14:00 → Thu 15:00 · undo 1d
agent ──COMMIT p1 + grant (signed by the human's key)──▶
      ◀─RECEIPT ✓ moved · undo until Fri 15:00
agent ──UNDO r1──────────────────────────────────────────▶
      ◀─RECEIPT ↶ undid r1
```

## The verbs

| Verb | What it does | Changes anything? |
|---|---|---|
| `HELLO` | Discover the service and its capabilities (the reply is a `BRIEF`) | No |
| `ASK` | Read. Agents may retry freely | Never |
| `INTENT` | Say what you want; get proposals back | No, unless `auto` commits (below) |
| `COMMIT` | Execute one proposal, bound by its hash | Yes |
| `UNDO` | Reverse a receipt inside its undo window | Yes |
| `EXPAND` | Fetch what a budget left out | No |

## Proposals

A proposal is a concrete plan the service offers. It's inert until committed, and it declares everything a human would want to know:

- **effects**: every change the commit will cause, as `create`, `update`, `delete`, `send` or `other`
- **uses**: optional, what the commit would use up, by name: `spend 22.87 USD`, `emails 1`. Grants can limit these ([limits](/guide/grants#limits-each-and-total))
- **risk**: `low`, `medium` or `high`, as the service assesses it
- **undo**: a window in seconds, or `null` if irreversible
- **expires**: when it stops being committable
- **hash**: covers all of the above, so the agent commits exactly what it saw

A service may offer alternatives, such as standard or express delivery, which CRUD can't express. A service must not perform effects beyond those declared in the committed proposal ([SPEC §5.1](/reference/spec#51-proposal)).

## When the request is ambiguous

The service replies `CLARIFY` with a question and options. Each option carries a params patch, so the agent picks one by merging it and sending the `INTENT` again. In the [playground](/playground), try "Ambiguous request".

## Committing

`COMMIT` carries the proposal id and its hash, plus the agent's grants and a proof of possession. The service rejects a hash mismatch with `conflict`. Only the agent whose verified proof was on the original `INTENT` may commit its proposals ([SPEC §4.4](/reference/spec#44-commit--make-it-happen)).

Commits are idempotent. Sending the same `COMMIT` again returns the original receipt with `replay: true` and never executes twice, so a retry after a lost response is safe.

## Auto-commit, gated by the human's policy

`INTENT` may carry `auto: true`. The service then commits the first proposal in the same round trip if, and only if:

1. one of the agent's grants authorizes that commit outright, with no consent needed, and
2. the proposal can be undone.

Otherwise the reply is ordinary proposals. So the principal's signed policy, not the agent, decides what may skip the preview: low-risk, undoable changes take one round trip, and anything over a limit, riskier or irreversible still stops for review ([SPEC §4.3.1](/reference/spec#431-policy-gated-auto-commit)).

## Undo

A receipt carries `undo.until`. `UNDO` before then reverses the effects the service can reverse; some can't be (you can't unsend an email), and the undo receipt says so. Only the principal who committed can undo.
