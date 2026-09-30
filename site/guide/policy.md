# How the policy works

An agent that can only read is safe and not much use. An agent holding your API key can do anything you can. The policy is the middle: the person signs, once, what their agent may do on its own, and everything past that comes back to them.

## The person signs it, the agent carries it

The person (the protocol calls them the **principal**) holds an Ed25519 key. They sign a grant that names the agent's key and lists its limits. That signed grant is the **policy**: "grant" is the protocol's word for the token, and "policy" is what it means to the person.

```sh
yea grant --svc shop.example --svc calendar.example --risk low \
  --each spend=40.00USD --total spend=100.00USD --exp 8h
```

That's the policy the [home page](/) runs: the example shop and calendar only, low-risk actions, up to $40 each and $100 in total, for eight hours.

The agent presents the token with each request, with a signature from its own key, so a copied token is useless without the agent's private key. The principal's private key must never be where the agent can use it: as long as it isn't, the agent can't widen its own policy or approve anything for the person. The policy is only as strong as where that key lives, so keep it on another OS user or device ([security model](/guide/security#rule-one-keep-the-principal-key-away-from-the-agent)).

## What it can limit

| Limit | Flag | Example |
|---|---|---|
| Which services | `--svc` | only `shop.example` and `calendar.example` |
| Which actions | `--can` | `calendar.*`, or one capability such as `shop.order` |
| Which verbs | `--verbs` | `ASK,INTENT`: read and propose, never commit |
| How much, per action | `--each` | `spend=40.00USD`, `emails=5` |
| How much, in total | `--total` | `spend=100.00USD` across every commit through this grant, counted at each service |
| How risky | `--risk` | `low`: anything `medium` or `high` goes back to the person |
| For how long | `--exp` | `8h`, `7d` |

The service states each proposal's `uses` (money, emails sent, records deleted), its `risk` and its undo window before anything happens, and the limits are checked against those. The service is trusted to report them truthfully and completely: a proposal that doesn't report a measure passes that measure's limit, and a measure the policy doesn't name isn't limited. The full rules are in [Grants and consent](/guide/grants#limits-each-and-total).

For an MCP server built with the framework, name its tools with `--can` (a policy without `can` lets nothing run on its own there) and issue the policy `--to` the server's id. Step 5 of the guides below shows how.

## Three outcomes

When the agent commits a proposal at a YEA service, the service checks every limit in the policy. There are three possible results:

| Outcome | When | What happens |
|---|---|---|
| **Goes ahead** | Every limit passes | The service commits and returns a receipt, with its undo window if it has one |
| **Asks the person** | It fails only on an amount (`each`, `total`) or the risk ceiling | The service replies `consent_required`. The person sees that exact proposal and, to approve it, signs a consent for its hash alone |
| **Refused** | Wrong service or action, expired, or a limit it can't read | The service replies `forbidden`. Nothing asks, because the policy never covered it. (A token that doesn't verify gets `unauthorized`.) |

With the home page's policy:

- **Order dinner** uses 53.95 USD, over the $40 limit: it asks.
- **Cancel a meeting** is `medium` risk, over the `low` ceiling: it asks.
- **Move a meeting** is low risk and uses nothing the policy limits: it goes ahead.

In an MCP server built with the framework, anything the policy doesn't let run on its own asks the person instead; only `deny` (below) refuses outright.

A consent approves one proposal hash, at one service, for one action, until the proposal expires. It can't be reused for anything else. Unknown or malformed limits are refused rather than skipped, so an older service never lets through more than a newer policy meant.

## Running on its own

Inside the policy, a plain `COMMIT` goes ahead whether or not the proposal can be undone: the limits are what bound it, so keep the risk ceiling low for anything irreversible.

An agent can also ask a service to commit in the same round trip it proposes (`INTENT` with `auto`), skipping the preview. The service does that only when the policy allows the first proposal outright **and** that proposal can be undone. Everything else is answered with proposals as usual ([auto-commit](/guide/intents#auto-commit-gated-by-the-humans-policy)).

MCP servers built with `@yea-protocol/mcp` or `yea-mcp` go further: a plan runs without asking only if it can be undone, whatever the policy says. Anything irreversible asks every time.

## Sub-agents

An agent can pass a narrower policy to a sub-agent by adding its own block to the grant: fewer services, a smaller limit, a shorter expiry. Caveats only accumulate, so a sub-agent can never do more than the agent that delegated to it, and what it spends counts against the totals set above it too.

```sh
yea delegate <token> --to <sub-agent key> --svc calendar.example --exp 1h
```

## Two files called "policy"

In an MCP server built with the framework:

- **The signed policy** (`YEA_POLICY`: a `pg1.` token, or the path of a file holding one) is the only thing that can let a plan run without asking.
- **`~/.yea/policy.json`**, or the server's options, hold unsigned local rules that can only tighten it: `deny` stops a tool from running at all, and `outOfBand` sends plans at or above a risk level to `yea approve` instead of the chat form.

## Where to go next

- **Add it to your MCP server:** step 5 of the [TypeScript](/guide/mcp-typescript#5-let-safe-things-run-on-their-own) or [Python](/guide/mcp-python#5-let-safe-things-run-on-their-own) guide signs a policy for one tool.
- **Try it without installing:** the [playground](/playground) lets you change the policy and watch what asks.
- **All the flags:** [`yea grant`](/reference/cli#identity-and-policy).
- **The exact rules:** [SPEC §6](/reference/spec#6-grants--delegation-for-agents).
