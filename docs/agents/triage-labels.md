# Triage Labels

The skills speak in terms of five canonical triage roles. This repo uses the default label for each.

| Label in mattpocock/skills | Label in our tracker | Meaning                                                                 |
| -------------------------- | -------------------- | ----------------------------------------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue                                 |
| `needs-info`               | `needs-info`         | Waiting on more information, or on something named in a comment         |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent                                 |
| `ready-for-human`          | `ready-for-human`    | Needs a human: a maintainer decision, credentials, money, or hands-on work |
| `wontfix`                  | `wontfix`            | Will not be actioned                                                    |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

Alongside these, triage also gives each issue an `area/*` label, a `priority/*` label (`P0` now, `P1` next, `P2` later) and a milestone; see [CONTRIBUTING.md](../../CONTRIBUTING.md#how-work-is-tracked). A claimed issue is assigned and labelled `in-progress`.
