# How the policy works

An agent that can only read is safe and not much use. An agent holding your API key can do anything you can. The policy is the middle: the person signs, once, what their agent may do on its own, and everything past that comes back to them.

## The person signs it, the agent carries it

The person (the protocol calls them the **principal**) holds an Ed25519 key. They sign a grant that names the agent's key and lists its limits. That signed grant is the **policy**: "grant" is the protocol's word for the token, and "policy" is what it means to the person.

```sh
yea grant --svc shop.example --svc calendar.example --risk low \
  --each spend=40.00USD --total spend=100.00USD --exp 8h
```

That's the policy the [home page](/) runs: the example shop and calendar only, low-risk actions, up to $40 each and $100 in total, for eight hours.

The agent presents the token with each request, with a signature from its own key, so a copied token is useless on its own. The agent never holds the principal's private key, which is why it can't widen its own policy or approve anything for the person. Keep that key on another OS user or device ([security model](/guide/security#rule-one-keep-the-principal-key-away-from-the-agent)).

## What it can limit

| Limit | Flag | Example |
|---|---|---|
| Which services | `--svc` | only `shop.example` and `calendar.example` |
| Which actions | `--can` | `calendar.*`, or one capability such as `shop.order` |
| How much, per action | `--each` | `spend=40.00USD`, `emails=5` |
| How much, in total | `--total` | `spend=100.00USD` across every commit through this grant |
| How risky | `--risk` | `low`: anything `medium` or `high` goes back to the person |
| For how long | `--exp` | `8h`, `7d` |

The service states each proposal's `uses` (money, emails sent, records deleted), its `risk` and its undo window before anything happens, and the limits are checked against those. A measure the policy doesn't name isn't limited. The full rules are in [Grants and consent](/guide/grants#limits-each-and-total).

## Three outcomes

When the agent commits a proposal, the service checks every limit in the policy. There are three possible results:

| Outcome | When | What happens |
|---|---|---|
| **Goes ahead** | Every limit passes | The service commits and returns a receipt with its undo window |
| **Asks the person** | It fails only on an amount (`each`, `total`) or the risk ceiling | The service replies `consent_required`. The person sees that exact proposal and, to approve it, signs a consent for its hash alone |
| **Refused** | Wrong service or action, expired, or a limit it can't read | The service replies `forbidden`. Nothing asks, because the policy never covered it |

With the home page's policy:

- **Order dinner** uses 53.95 USD, over the $40 limit: it asks.
- **Cancel a meeting** is `medium` risk, over the `low` ceiling: it asks.
- **Move a meeting** is low risk and uses nothing the policy limits: it goes ahead.

A consent approves one proposal hash, at one service, for one action, until the proposal expires. It can't be reused for anything else. Unknown or malformed limits are refused rather than skipped, so an older service never lets through more than a newer policy meant.

## Running on its own

An agent can ask a service to commit in the same round trip it proposes (`INTENT` with `auto`). The service does that only when the policy allows the first proposal outright **and** that proposal can be undone. Everything else is answered with proposals as usual ([SPEC §4.3.1](/reference/spec#431-policy-gated-auto-commit)).

MCP servers built with `@yea-protocol/mcp` or `yea-mcp` go further: a plan runs without asking only if it can be undone, whatever the policy says. Anything irreversible asks every time.

## Sub-agents

An agent can pass a narrower policy to a sub-agent by adding its own block to the grant: fewer services, a smaller limit, a shorter expiry. Limits only add up, so a sub-agent can never do more than the agent that delegated to it.

```sh
yea delegate <token> --to <sub-agent key> --verbs ASK,INTENT
```

## Two files called "policy"

In an MCP server built with the framework:

- **The signed policy** (`YEA_POLICY`, a `pg1.` token) is the only thing that can let a plan run without asking.
- **`~/.yea/policy.json`** holds unsigned local rules that can only tighten it: `deny` stops a tool from running at all, and `outOfBand` sends plans at or above a risk level to `yea approve` instead of the chat form.

## Where to go next

- **Add it to your MCP server:** step 5 of the [TypeScript](/guide/mcp-typescript#5-let-safe-things-run-on-their-own) or [Python](/guide/mcp-python#5-let-safe-things-run-on-their-own) guide signs a policy for one tool.
- **Try it without installing:** the [playground](/playground) lets you change the policy and watch what asks.
- **All the flags:** [`yea grant`](/reference/cli#identity-and-policy).
- **The exact rules:** [SPEC §6](/reference/spec#6-grants--delegation-for-agents).
