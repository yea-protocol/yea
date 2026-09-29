# HTTP was built for browsers. Agents need their own protocol.

*Why we built YEA, and what we learned building it.*

---

Every layer of the web assumes a particular reader.

HTML and CSS assume a **human**: someone who scans, clicks, and notices when a button
says "Delete account". REST APIs assume **code**: a program a developer wrote in advance,
that knows exactly which endpoint to call and treats every response the same way,
millions of times, for fractions of a cent.

AI agents are neither. An agent reads everything it's sent, and it pays for every token
it reads. It decides at runtime what to call. It makes plausible mistakes. It acts *for
someone else*, who is usually not watching. Nearly all of our infrastructure was designed
for the other two readers.

## What goes wrong today

Watch an agent do something simple, like moving a meeting, over a typical API.

It searches events, lists free slots, then updates the event: three round trips, each
returning JSON with quotes, braces and repeated keys it pays for, and each round trip
re-reading everything so far. Then the update happens. The agent never saw, in any
standardized form, that the change would email the attendee, that it can't be taken
back, or whether its owner would have wanted it. It holds a credential that is scoped to
*resources* ("calendar: write"), not to *actions* ("move this meeting, if it's
reversible").

MCP made these APIs easy to plug into a model, and that was a real step. But an MCP tool
is usually a thin wrapper over the same endpoint. The shape underneath is still CRUD
built for code.

We think the fix belongs in the protocol, the way HTTP's verbs and status codes made the
web work for browsers.

## Five ideas

**1. Say what you want, get proposals back.** The agent sends an `INTENT` ("move my 1:1
with Ana to Thursday"). The service, which understands its own domain, answers with
concrete **proposals**, each listing its effects (`~ update event/e2.start 14:00 → Thu
15:00`, `> send ana@… updated invite`), its cost, its risk, and how long it can be undone.
Nothing has happened yet.

**2. The human's policy decides what needs a human.** The agent carries a **grant**: a
small, signed statement from its principal, such as "this agent may act on calendar and
shop, low-risk only, $40 per action, $100 total, for 8 hours." If a proposal fits the
policy and can be undone, the agent can commit it in the same round trip. If it doesn't,
the service answers `consent_required`, and the human approves *that exact proposal* by
signing its hash. Approval is cryptographic, one-shot, and bound to the effects the human
actually saw.

**3. Undo is a verb.** Receipts carry an undo window. When the human says "not that day",
the agent sends `UNDO`, and the protocol handles it.

**4. Budgets and Lens.** Every request says how many tokens the agent can afford for the
reply. The service fits the reply to that budget and leaves an `EXPAND` handle for the
rest. Replies come in **Lens**, a compact text format specified to the byte: tables for
uniform lists, explicit costs and undo windows, and identical output across
implementations. It's written for models to read.

**5. Errors that teach.** An error says how to fix itself, with a machine-applicable
patch: `did you mean calendar.agenda?`, or `rename dya to day`. When a request is
ambiguous, the service asks (`CLARIFY: which Ana?`) instead of guessing.

## What we measured, including where we were wrong

We benchmarked the same tasks, over the same data, against a conventional REST-style MCP
server. Our first run went against us. On a multi-step order task, YEA used
**more** tokens, because the preview step costs a round trip, and every turn re-reads
the whole context.

That result led to the most important feature in the protocol: **policy-gated
auto-commit**. The human's grant decides what can skip the preview. In a scripted payload
benchmark, YEA now sends the model 32% fewer tokens than minified-JSON REST. Against a
REST server with an equally outcome-shaped endpoint, the difference is only 4%.

Then we ran real agents, and the numbers got humbler. In headless Claude Code, the same
tasks cost about the same through YEA as through a REST MCP server: 3–15% more, with
the same success rate. In live use the bill is dominated by model *turns*, each one
re-reading tens of thousands of tokens of harness context, not by tool payloads. When the
model handed its goal straight to an intent, a reschedule took one call instead of three.
When it double-checked a price by fetching the real proposal first, it spent an extra
turn. We [publish all of it](../bench/agent-eval/), including the mistakes we made
building the eval. The honest claim is **the safety comes at roughly no extra cost**, not
that it saves money.

The budget story is starker against real APIs. Pointed at the live Swagger Petstore, a
single `findPetsByStatus` call returns 4,019 pets, about 120,000 tokens. A typical MCP
wrapper puts all of it in context. Through YEA's OpenAPI adapter, the model gets what
fits its budget and a handle for the rest.

Both arms had zero rule violations, even when we hid a fake "the owner pre-approved $200"
note in a menu item. A well-behaved model follows stated rules either way. The difference
is that YEA's rules are enforced by the service, so they still hold when a model
doesn't.

Earlier, we gave Claude Sonnet 5 the protocol with **no documentation**, and asked it to move
a meeting and order some meals. It read Lens cold and committed the meeting within
policy. It stopped when the order exceeded the per-action limit. Unprompted, it told the
user that splitting the order in two would dodge the limit, and that it hadn't done that.
Then it handed the human the approval command.

## Built twice, reviewed hard

A spec implemented once is a description of one codebase. YEA has two
implementations, TypeScript and Python, that pass the same conformance vectors and
interoperate in both directions, down to byte-identical Lens.

Building the second one found real bugs in the first. The worst was a consent grant that
was supposed to approve one purchase but, for ten minutes, authorized undoing unrelated
orders. An adversarial security audit then found fifteen more issues, including a crash
reachable with one malformed request, a race that let concurrent commits exceed a spend
cap, and a way for a malicious service to get a human to sign for a different service's
proposal. All are fixed, covered by regression tests, and written into the spec. They're
listed in [the design notes](design.md#security-review), because a protocol that asks you to
trust it with delegated authority should show its work.

## What YEA is not

It's not a replacement for MCP. The MCP bridge serves YEA *over* MCP, so Claude Code,
Claude Desktop and Cursor can use YEA services today. It's not an agent framework, and
it doesn't care which model you use. And it's not finished. v1 has no revocation lists,
no multi-service atomic commits, and it trusts services to describe their own effects
honestly. The [roadmap](design.md#roadmap) covers what's next.

## Try it

```sh
npx @yea-protocol/cli demo                        # the whole story in 30 seconds
npx @yea-protocol/cli openapi <your-openapi.json> # any REST API, as a YEA service
```

> **Unreleased:** `@yea-protocol/cli` isn't on npm yet, so these fail for now. Until it's
> published, run them from a clone, with `node cli/bin/yea.js` in place of `npx @yea-protocol/cli`,
> after `git clone https://github.com/yea-protocol/yea && cd yea && npm ci && npm run build`.
> The [playground](https://yea-protocol.github.io/yea/playground) needs nothing installed.

Read the [spec](../SPEC.md). It's short on purpose. If you build a service or an
implementation, or find a hole, [open an issue](https://github.com/yea-protocol/yea/issues).
Feedback on the spec is the most valuable contribution right now.
