# Conventions for `uses`

*Non-normative.* [SPEC.md](../SPEC.md) gives measure names and units no meaning: a grant's
`each` and `total` limits only work when the service and the person granting mean the same
thing by a name. These conventions keep that consistent across services, so one limit works
everywhere. Services SHOULD follow them where they apply, and document any measures of their
own.

## Money: `spend`

Money leaving the principal's control: charges, payments, payouts, and refunds they issue.

| Field | Value |
|---|---|
| name | `spend` |
| `unit` | the ISO 4217 code, uppercase (`USD`, `EUR`, `JPY`) |
| `scale` | the currency's minor-unit digits: `2` for USD and EUR, `0` for JPY, `3` for KWD |
| `amount` | the value in minor units: 22.87 USD is `{"amount": 2287, "scale": 2, "unit": "USD"}` |

Limits don't need the currency's scale. Values compare exactly across scales, so a grant can
say `{"each": {"of": "spend", "max": 25, "unit": "USD"}}` (scale 0), and it limits proposals
reported in cents correctly.

A plan that costs money in two currencies can't report both under `spend`, because a map
holds one quantity per name. Offer one plan per currency instead. A `spend` limit in one
currency never admits another: the units don't match, so the check asks the person instead.

## Counts

Things an action does a number of times. Use a plural noun, with no `unit` and scale `0`.

| Name | Counts |
|---|---|
| `emails` | emails sent |
| `messages` | chat, SMS or push messages sent |
| `deletions` | records, files or objects deleted |
| `invites` | invitations sent to other people |

`{"total": {"of": "emails", "max": 20}}` in a grant then means "at most 20 emails under this
grant", whichever service sends them.

## Your own measures

Pick a lowercase name that says what is used up (`api_calls`, `storage`), with a unit when the
number needs one (`{"amount": 5, "unit": "GB"}`). List them in your service's docs, so the
people writing grants know what they can limit.
