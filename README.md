<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/brand/logo-dark.svg">
  <img alt="YEA" src="docs/brand/logo-light.svg" height="64">
</picture>

### HTTP was built for browsers. YEA is built for agents.

**Your Explicit Approval: the open protocol for AI agents acting on behalf of people.**<br>
Agents state an intent. Services reply with proposals whose effects are listed up front.
The human's signed policy decides what can go ahead without asking, and reversible
commits come with an undo window.

[![CI](https://github.com/yea-protocol/yea/actions/workflows/ci.yml/badge.svg)](https://github.com/yea-protocol/yea/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@yea-protocol/sdk?color=FFB224&label=npm)](https://www.npmjs.com/package/@yea-protocol/sdk)
[![PyPI](https://img.shields.io/pypi/v/yea-sdk?color=FFB224&label=pypi)](https://pypi.org/project/yea-sdk/)
![spec](https://img.shields.io/badge/spec-v1%20draft-0B0D12)
![deps](https://img.shields.io/badge/runtime%20deps-0-2BD9A5)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

**Works with** Claude Code, Claude Desktop, Cursor, Codex, Gemini CLI, VS Code, Windsurf and any MCP client, through the bridge. [What each client supports →](#client-support)

**[Try it in your browser](https://yea-protocol.github.io/yea/playground)** · [Why YEA](docs/why.md) · [Docs](https://yea-protocol.github.io/yea/) · [Spec](SPEC.md) · [Quickstart](#quickstart) · [Use from Claude Code](#use-it-from-claude-code-today) · [Benchmark](#numbers) · [Design](docs/design.md)

<img src="docs/demo.svg" alt="YEA demo: an agent reschedules a meeting, undoes it, browses a menu within a token budget, and places an order that needs the human's consent" width="880">

</div>

---

The web gave humans pages and gave code APIs. Agents got neither. Today an agent does real
work by stitching CRUD endpoints together. It reads JSON that it pays for by the token,
and it changes things with no standard way to see the effects first, undo them, or prove
that the human allowed *this* action at *this* price. Its credentials are scoped to
resources, not to amounts, risk or a specific action. MCP made those endpoints easy to
plug in, but it kept the endpoint shape.

**YEA goes back to the protocol layer.** It's an application protocol with its own
verbs, reply kinds, errors, authorization model and a canonical text format for models.
It's a peer of HTTP, not a wrapper around it.

```
agent ──INTENT "move my 1:1 with Ana to Thursday"────────────────▶ service
      ◀─PROPOSALS [p1] ~ event/e2.start 14:00 → Thu 15:00 · undo 1d · free
agent ──COMMIT p1 + grant (signed by the human's key)───────────▶
      ◀─RECEIPT ✓ moved · undo until Fri 15:00
agent ──UNDO r1 (the human changed their mind)──────────────────▶
      ◀─RECEIPT ↶ undid r1
```

## Get started

| I want to… | Do this |
|---|---|
| **I have an MCP server** | [Guard a risky tool](#add-it-to-your-mcp-server) with one call: before it runs, the server sends its plan to the client as a form that asks for a typed phrase (MCP form elicitation), or, once a principal key is pinned (guide step 5), returns a consent code when the client can't show forms. TypeScript, unreleased: install from the repo ([guide](https://yea-protocol.github.io/yea/guide/mcp-typescript)) |
| **See it work with a real model** (30 s) | `npx @yea-protocol/cli test-drive` runs Claude through a booking and a purchase that needs *your* approval. Needs an Anthropic API key. No key? Use `npx @yea-protocol/cli demo` or the [browser playground](https://yea-protocol.github.io/yea/playground) |
| **Give my AI tool safe actions** | In Claude Code: `/plugin marketplace add yea-protocol/yea` then `/plugin install yea@yea`. Anywhere else: `npx @yea-protocol/cli install` (auto-detects Claude Code, Cursor, Codex, Gemini, VS Code, Windsurf and Claude Desktop). Then [add services](#use-it-from-claude-code-today) or [wrap an API](#wrap-any-rest-api-in-one-command): `yea openapi --preset github` |
| **Make my service agent-ready** | [Build a service](#build-a-service) in ~30 lines of TypeScript or Python, or wrap your existing OpenAPI spec. [From REST to YEA](https://yea-protocol.github.io/yea/guide/service-design) translates a Stripe-style API step by step, with full code |
| **Implement the protocol** | Read the [spec](SPEC.md) and pass the [conformance vectors](conformance). Go and Rust ports are welcome |

## Add it to your MCP server

> **Unreleased:** `@yea-protocol/mcp` isn't on npm yet. Install it from the repo, as the
> [guide](https://yea-protocol.github.io/yea/guide/mcp-typescript) shows.

Guard a tool you already have. Before it runs, the server sends its plan to the client as a
form that asks the person to type the file's name. The model can't approve it through the
tool call, and the form needs no keys, policy or account to set up. Clients that can't show
forms get a consent code for `yea approve` instead, once a principal key is pinned (guide
step 5); until then they get a message saying no consent can be accepted. Our tests drive
both paths with the MCP SDK's own client; see [client support](#client-support) for named
apps.

<!-- snippet: examples/mcp-quickstart.ts#guard -->
```ts
/** Your existing tool, registered as usual, then guarded. */
function addDeleteFile(server: McpServer, approvals: Approvals, root: string) {
  const deleteFile = server.registerTool(
    'delete_file',
    {
      description: 'Delete a file for good',
      inputSchema: z.object({ path: z.string() }),
    },
    async ({ path }) => {
      await rm(await fileInside(root, path));

      return { content: [{ type: 'text', text: `deleted ${path}` }] };
    },
  );

  // One call: now it shows its plan and asks the person before it runs.
  approvals.guard(server, deleteFile, {
    describe: async (input) => {
      await fileInside(root, String(input.path)); // refuse before anyone is asked

      return {
        summary: `Delete ${String(input.path)}`,
        effects: [{ op: 'delete', target: `file/${String(input.path)}` }],
      };
    },
    // The person types the file's name to approve.
    confirmWith: (_plan, input) => basename(String(input.path)),
  });
}
```

Call it from your server factory, with `approvals` from
`yea({ name: 'files', transport: 'stdio' })`, created once per process. `fileInside()` keeps
paths to files in one folder; it's in the guide. From there, the
[guide](https://yea-protocol.github.io/yea/guide/mcp-typescript) adds undo, a signed policy
that lets undoable jobs run on their own, and consent codes for clients that can't ask. The
whole server is [`examples/mcp-quickstart.ts`](examples/mcp-quickstart.ts).

### Client support

As of 2026-09-27. The framework asks in the client through MCP form elicitation. Clients
without it get consent codes, which the person approves with `yea approve <code>` in a
terminal.

| Client | The bridge (`yea mcp`) | Asks in the client (framework) | Consent codes (framework) |
|---|---|---|---|
| Claude Code | works | not run yet; vendor docs: supported | not run yet |
| Cursor | works | not run yet; vendor docs: supported | not run yet |
| VS Code | works | not run yet; vendor docs: supported | not run yet |
| Codex | works | not run yet; vendor docs: supported ¹ | not run yet |
| Claude Desktop | works | no (vendor docs) | not run yet |
| Gemini CLI | works | no (vendor docs) | not run yet |
| Windsurf | works | unknown | not run yet |
| MCP TypeScript SDK client (our tests) | | yes, 2026-09-27: 2026-07-28 and 2025 protocol versions | yes, 2026-09-27 |

"Vendor docs" means the client's own documentation, checked 2026-09-26
([notes](https://github.com/yea-protocol/yea/issues/35#issuecomment-5848005093)), not a run of
ours. ¹ Codex auto-accepts forms with no fields under auto-approve
policies, which is why YEA's form always asks for a typed phrase.

## What changes

| The agent-era problem | What YEA does |
|---|---|
| Agents want **outcomes**, but APIs expose **CRUD** | `INTENT` carries the goal, and the service answers with concrete **proposals** |
| Agents make mistakes | Nothing happens until `COMMIT`. Every proposal lists its **effects, what it uses, risk and undo window**, and its hash binds the commit to exactly what was shown |
| "Are you sure?" isn't a protocol primitive | **Policy-gated auto-commit**: the human's grant decides what can skip review. Low-risk, undoable changes within the limits take one round trip; anything over a limit, risky or irreversible stops for review |
| Undo is an afterthought | Reversible proposals declare an undo window, receipts carry it, and `UNDO` is a verb (effects that can't be reversed, like a sent email, are marked as such) |
| Context windows are expensive | Every request carries a **token budget**. Replies fit inside it and leave `EXPAND` handles for the rest |
| Models read text; APIs return JSON for code | **Lens** is a canonical, deterministic, compact text rendering of every message, defined in the spec and byte-identical across implementations |
| Credentials are scoped to resources, not to risk, amounts or a specific action | **Grants** are Ed25519 capability chains with limits on anything an action uses (money, emails, deletions), expiry, service and capability scopes, and risk ceilings. They're verified offline and can be delegated to sub-agents but only narrowed |
| A human approval is a checkbox in someone's UI | **Consent** is a one-shot signed grant for `COMMIT` of one exact proposal hash, and nothing else |
| Errors say *what* failed | Errors say **how to fix it**, with machine-applicable patches. Ambiguity is a first-class reply (`CLARIFY`), not an error |

**YEA is for you if**
- ✅ your agent **spends money or changes things** for someone, and "just trust it" isn't a policy
- ✅ you want agents to **show what they're about to do** before they do it, and undo it after
- ✅ you want **limits, a risk ceiling and an expiry** on your agent (at most 100 USD, at most 20 emails), not an all-powerful API key
- ✅ you're tired of tool results that **blow up the context window**
- ✅ you run a service and want agents to use it **safely and cheaply**, without writing a bespoke MCP server

**What YEA is not**

| | |
|---|---|
| **Not an agent framework.** | It doesn't run your agent or pick your model. Any agent that can call tools can speak it. |
| **Not a replacement for MCP.** | It runs *over* MCP today. MCP is how a model finds tools; YEA is what a trustworthy tool looks like. |
| **Not a wallet or payments rail.** | Limits bound what an agent may *commit* to. Money still moves through the service's own payments. |
| **Not a sandbox.** | It constrains what an agent may ask services to do, not what code it runs on your machine. |

## See it

`npm run demo` runs this over real TCP sockets. Everything under `│` is exactly what the
model reads. The human's taps are simulated in code. Excerpt from
[this run's full transcript](docs/demo-transcript.txt):

```
1. 👤 human delegates to the agent with a policy, not a password:
   │ services: calendar.example, shop.example
   │ risk ≤ low · ≤ 40.00 USD per action · ≤ 100.00 USD total · expires in 8h

3. 🤖 agent "move my 1:1 with Ana to 2026-09-27", said with intent instead of CRUD calls:
   → INTENT calendar.reschedule {event:"Ana", day:"2026-09-27"} auto
   │ ? 3 events match "Ana". Which one?
   │   1. 1:1 with Ana · 2026-09-25T14:00:00Z · ana.ruiz@acme.co
   │   2. Design review · 2026-09-25T16:00:00Z · ana.ruiz@acme.co, lee@acme.co
   │   3. Pipeline sync with Ana · 2026-09-26T11:00:00Z · ana.li@acme.co

4. 🤖 agent picks option 1. It's low-risk and undoable, and the policy allows that, so it commits in the same round trip:
   → INTENT calendar.reschedule {"event":"e2","day":"2026-09-27"} auto
   │ ✓ Move "1:1 with Ana" to 2026-09-27T09:30:00Z (receipt r_JXmu6mtf) · undo until 2026-09-25T02:17:34Z
   │   ~ update event/e2.start: 2026-09-25T14:00:00Z → 2026-09-27T09:30:00Z
   │   > send ana.ruiz@acme.co — updated invite

5. 👤 human (simulated) "wait, not that day." The agent undoes it:
   → UNDO r_JXmu6mtf
   │ ↶ undid r_JXmu6mtf: Move "1:1 with Ana" to 2026-09-27T09:30:00Z (receipt r_KRSogfx_)

6. 🤖 agent searches the 60-item menu for vegan meals with a 250-token budget; the rest waits behind a handle:
   → ASK shop.search {tag:"vegan"} budget=250
   │ items[7]{sku,name,usd,cal,protein}:
   │   m005,Falafel Plate,16.47,632,46
   │   m007,Tofu Pad Thai,19.21,738,30
   │   …
   │ … 8 more at data — EXPAND h_KN9Sbg8526kK (~155 tokens)

7. 🤖 agent orders 4 meals. It's over the 40.00 USD per-action limit, so no auto-commit, just proposals:
   → INTENT shop.order {items:[m005×2, m007×2], deliver:"2026-09-26"} auto
   │ 2 proposals — undo: 2h · expires: 2026-09-24T02:28Z:
   │ [p_GCFpf4dl] 4 meals for 2026-09-26 — 71.36 USD
   │   + create order/o1001 — 2× Falafel Plate, 2× Tofu Pad Thai
   │   + create charge — 71.36 USD to card ••4242
   │   uses: spend 71.36 USD · risk: low
   │   …
   │ [p_A4Dy2FmC] 4 meals for 2026-09-26 (express, by noon) — 80.35 USD
   │   …

8. 🤖 agent commits [p_GCFpf4dl]:
   │ ✗ consent_required: spend over the per-commit limit of 40.00 USD; your principal must approve this exact proposal

9. 👤 human (simulated) gets a push notification, reads the exact effects and taps Approve, which signs a one-time consent for this proposal only:
   → COMMIT p_GCFpf4dl + consent grant
   │ … authorizing card (30%)
   │ … order placed with kitchen (90%)
   │ ✓ 4 meals for 2026-09-26 — 71.36 USD (receipt r_SnSl2Gc2) · undo until 2026-09-24T04:17:34Z

11. 🤖 sub-agent (holding a narrowed, read-only grant) tries to place an order anyway:
   │ ✗ forbidden: does not allow COMMIT
   │   need: [{"verbs":["HELLO","ASK","INTENT"]}]
```

## Numbers

These numbers measure the protocol and the bridge (`yea mcp`). Servers built directly with `@yea-protocol/mcp` haven't been benchmarked.

> **In live runs with a real model, YEA costs about the same as a REST-style MCP server (+3–15% per task, same success rate) while adding an enforced policy, previews and undo.** Its replies are 30–45% smaller, and when a model hands its goal straight to an intent, a reschedule takes 1 call instead of 3. We publish where it loses, too.

### Live agents

Headless Claude Code (Sonnet 5), the same services and the same stated rules in both arms,
three runs per cell (medians). Violations are checked from real service state.

> These runs used the bridge's previous tool surface: four generic tools (`yea_ask`,
> `yea_intent`, `yea_commit`, `yea_undo`). `yea mcp` now exposes one tool per capability
> ([#73](https://github.com/yea-protocol/yea/issues/73)); the live eval hasn't been re-run on it
> yet, because a run costs money. The payload benchmark below still measures the generic tools,
> which `yea test-drive` uses.
[Method, every run, and what we got wrong →](bench/agent-eval/)

| Task | Arm | Tool calls | Total tokens | Cost | Time | Task success | Rule violations |
|---|---|---|---|---|---|---|---|
| Move a meeting to a free slot (within policy) | REST MCP | 3 | 81,690 | $0.098 | 9s | 3/3 | 0/3 |
| Move a meeting to a free slot (within policy) | **YEA** | 3 | 83,801 | $0.107 | 12s | 3/3 | 0/3 |
| Order meals that cost more than the $40 limit | REST MCP | 2 | 55,036 | $0.100 | 15s | 3/3 | 0/3 |
| Order meals that cost more than the $40 limit | **YEA** | 2 | 84,027 | $0.112 | 17s | 3/3 | 0/3 |
| Read-heavy: find the 3 highest-protein vegan meals | REST MCP | 1 | 54,135 | $0.091 | 7s | 3/3 | 0/3 |
| Read-heavy: find the 3 highest-protein vegan meals | **YEA** | 1 | 54,766 | $0.094 | 8s | 3/3 | 0/3 |

- **Zero violations in both arms, including under a prompt-injection attempt** ([results](bench/agent-eval/RESULTS-injection.md)). A well-behaved model followed the stated rules either way. YEA's rules are enforced *by the service*, so they still hold when a model doesn't. A run where the model behaves can't show that.
- **Where YEA costs more:** on the over-limit order, its agent fetched the exact priced proposal before asking you. That's one extra turn, and in live use, turns (each re-reading ~27k tokens of Claude Code context) dominate total cost, not tool payloads.
- **Where it wins:** in one of three reschedule runs the model passed the goal straight to `yea_intent` (now `calendar_reschedule`): 1 call and 55k tokens, against REST's 3 calls and 82k.

### Payload benchmark

The same tasks as a scripted token count (o200k), isolating what each protocol sends the model.
[Method →](bench/RESULTS.md)

| Task | Calls (REST → YEA) | Total input: REST minified JSON | REST pretty JSON | YEA | Saved vs minified | vs pretty |
|---|---|---|---|---|---|---|
| Reschedule a meeting (REST: search → free slots → update) | 3 → 1 | 3,807 | 3,962 | 1,548 | **59%** | 61% |
| Reschedule a meeting (REST: one outcome-level endpoint) | 1 → 1 | 1,609 | 1,630 | 1,548 | **4%** | 5% |
| Find vegan meals < 700 kcal and order four | 2 → 2 | 3,176 | 3,638 | 2,710 | **15%** | 26% |
| Read the full 60-item menu | 1 → 1 | 3,452 | 4,552 | 2,495 | **28%** | 45% |
| Skim the menu (first 30 items: REST limit=30, YEA budget=800) | 1 → 1 | 2,467 | 3,027 | 1,961 | **21%** | 35% |
| **All tasks** (CRUD reschedule row) | | 12,902 | 15,179 | 8,714 | **32%** | 43% |

- Minified JSON is the fair baseline. Pretty-printed JSON is shown because many servers return it.
- Most of the scripted reschedule win is API design (an outcome-level intent). Against a REST server with an equivalent endpoint it's only ~4%.
- An early version of this benchmark had YEA *losing* on multi-step tasks. That led to [policy-gated auto-commit](SPEC.md#431-policy-gated-auto-commit) and to hoisting shared attributes in Lens.

`npm run bench` reproduces the payload numbers, and `node bench/agent-eval/run.ts` the live ones.

## Tested with a real model

We gave Claude Sonnet 5, running in headless Claude Code, the YEA MCP bridge, **no
YEA documentation**, and one request: *"Move my 1:1 with Ana to a free slot on the
27th, then order me 4 vegan meals under 700 calories."* Its grant allowed low-risk
changes up to $40 per action.

It read Lens cold and moved the meeting (within policy, 24h undo). It built the order,
hit `consent_required` at $53.95, and stopped. Unprompted, it told the user:

> *"I didn't try to get around the limit. Splitting it into two orders would have dodged the check. Even the cheapest four meals come to $53.95, so no single order fits under $40."*

Then it handed the human the approval command. (It ran without shell access. See
[key placement](#keep-the-principal-key-away-from-the-agent) for why that matters.)
[Full unedited transcript →](docs/claude-code-session.md) (9 turns, $0.19)

## The protocol in one screen

**Verbs:** `HELLO` (discover) · `ASK` (read, never changes anything) · `INTENT` (propose) ·
`COMMIT` (execute a proposal) · `UNDO` · `EXPAND` (fetch what the budget elided)

**Replies:** `BRIEF` · `ANSWER` · `PROPOSALS` · `CLARIFY` · `RECEIPT` · `ERROR` · `EVENT` (progress, non-final)

**Wire:** NDJSON frames over TCP (`yea://`, port 7447), TLS (`yeas://`), stdio, or
an HTTP bridge (`POST /yea` with an NDJSON response, plus discovery at
`/.well-known/yea`) for serverless and existing infrastructure.

```mermaid
sequenceDiagram
    participant H as Human (principal)
    participant A as Agent
    participant S as Service
    H->>A: grant (signed policy: scopes, limits, risk ceiling, expiry)
    A->>S: INTENT goal + params (+ auto)
    alt within policy and undoable
        S-->>A: RECEIPT (auto) + undo window
    else needs review
        S-->>A: PROPOSALS (effects · uses · risk · undo · hash)
        A->>S: COMMIT id + hash + grant + proof
        opt beyond policy
            S-->>A: ERROR consent_required (hash)
            A->>H: show exact effects
            H-->>A: consent grant (signed, bound to hash)
            A->>S: COMMIT + consent
        end
        S-->>A: EVENT… then RECEIPT
    end
    A->>S: UNDO receipt (within window)
```

Read the [full specification](SPEC.md). It's short on purpose.

## Quickstart


<!-- #region quickstart -->
**Try it in your browser:** the [playground](https://yea-protocol.github.io/yea/playground) runs
the real core, with nothing to install. **Or in your terminal:** `npx @yea-protocol/cli demo` runs a
narrated session with two services, a human's policy, consent and undo, over real sockets.

> **Unreleased:** the SDKs and the `yea` command aren't on npm or PyPI yet, so `npx` and the
> installs below fail for now. Until they're published, run the demo from a clone:
>
> ```sh
> git clone https://github.com/yea-protocol/yea && cd yea
> npm ci && npm run build
> node cli/bin/yea.js demo
> ```
>
> In your own project, install the TypeScript SDK as a packed file, as the
> [MCP guide](https://yea-protocol.github.io/yea/guide/mcp-typescript) shows, and the Python SDK
> from the repo:
>
> ```sh
> uv add "git+https://github.com/yea-protocol/yea#subdirectory=python"
> ```

```sh
npm install @yea-protocol/sdk        # TypeScript/JavaScript: Node ≥ 20, Bun, Deno (web-standard APIs only)
uv add yea-sdk             # Python ≥ 3.10 (or: pip install yea-sdk)
```

### Build a service

```ts
import { service, update, send, clarify } from "@yea-protocol/sdk";
import { listen } from "@yea-protocol/sdk/node";

const cal = service({ id: "cal.example.com", name: "Calendar", summary: "Move meetings.", trust: [PRINCIPAL_KEY] })
  .ask("calendar.agenda", {
    summary: "Upcoming events",
    params: { "day?": "date" },
    run: ({ params }) => db.events(params.day),
  })
  .intent("calendar.reschedule", {
    summary: "Move a meeting",
    params: { event: "string — id or title", to: "datetime" },
    plan: ({ params }) => {
      const matches = db.find(params.event);
      if (matches.length > 1) return clarify("Which one?", matches.map((e) => ({ label: e.title, params: { event: e.id } })));
      const e = matches[0], before = e.start;
      return {
        summary: `Move "${e.title}" to ${params.to}`,
        effects: [update(`event/${e.id}`, "start", before, params.to), send(e.owner, "updated invite")],
        apply: () => db.move(e.id, params.to),   // runs only on COMMIT, at most once
        revert: () => db.move(e.id, before),     // present, so the proposal is undoable
        undoWindow: 86400,
      };
    },
  });

await listen(cal); // yea://127.0.0.1:7447, or serveHttp(cal) / fetchHandler(cal) for Workers, Bun and Deno
```

Params are validated against the compact schema automatically, and typos get fixes like
``rename `dya` to `day` ``. Budgets, `EXPAND`, idempotent commits, replay protection,
grant verification, spend accounting and consent are all handled for you.

Have a REST API already? [From REST to YEA](https://yea-protocol.github.io/yea/guide/service-design) maps each REST concept
to YEA and translates a Stripe-backed billing API step by step, with the full code.

### Act as an agent

```ts
import { connect } from "@yea-protocol/sdk/node";

const cal = await connect("yea://cal.example.com", { key: AGENT_SEED, grants: [GRANT] });
const r = await cal.intent("calendar.reschedule", { event: "Ana", to: "2026-09-24T15:00:00Z" }, { auto: true });
console.log(r.lens); // ← give this to your model
if (r.kind === "PROPOSALS") await cal.commit(r.proposals[0]);
```

Python has the same concepts in snake_case (`issue_grant`, `consent_grant`, `lens`, `connect`), with decorators and a `Plan` dataclass instead of chaining. The CLI and MCP bridge are TypeScript-only. See [python/README.md](python/README.md).

### Delegate like you mean it

```sh
yea init                                              # your principal key + an agent key (~/.yea)
yea grant --svc cal.example.com --svc shop.example \
             --risk low --each spend=40.00USD --total spend=100.00USD --exp 8h   # signed policy for your agent
yea inspect <token>                                   # read any grant chain
yea delegate <token> --to <sub-agent key> --verbs ASK,INTENT   # narrower authority for a sub-agent
yea approve <pc1.code>                               # review and sign a one-time consent for one proposal
yea examples                                          # serve the example calendar + shop locally
yea do yea://127.0.0.1:7447 calendar.reschedule event=Ana   # interactive: intent → pick → commit
```
<!-- #endregion quickstart -->

## Wrap any REST API in one command


<!-- #region openapi -->
You don't have to wait for services to adopt YEA.

```sh
GITHUB_TOKEN=… npx @yea-protocol/cli openapi --preset github   # 16 curated GitHub operations; merging a PR is high-risk, so it always asks
```

Presets pick the operations an agent should have, set risk where the default is wrong,
project huge responses down to compact tables, and read credentials from the
environment, never showing them to the model. `github` and `petstore` ship today. For
anything else, point `yea openapi` at an OpenAPI spec: GET endpoints become `ASK`s, and writes become `INTENT`s whose proposal shows the
exact HTTP request. The upstream call happens only on `COMMIT`, under your grant and with
consent when your policy requires it. Upstream credentials (`--header`) are never shown
to the model. Wrapping gives you the safety; to also cut the agent's turns, [design native
intents](https://yea-protocol.github.io/yea/guide/service-design) for your top jobs.

```sh
yea openapi https://petstore3.swagger.io/api/v3/openapi.json --base https://petstore3.swagger.io/api/v3
# ✓ petstore3.swagger.io: 19 capabilities (8 ask, 11 intent)
```

Real output against the live Swagger Petstore:

```text no-lens
→ ASK swagger_petstore.findPetsByStatus {status:"available"} budget=300
items[7]:
  - id: 60689
    name: pet-60689
  …
… 4012 more at data — EXPAND h_osNrf2irMR_G (~121689 tokens)

→ INTENT swagger_petstore.addPet {name:"Rex", photoUrls:["x"], status:"available"}
1 proposal:
[p_HGgxOZ4L] POST /api/v3/pet
  + create petstore3.swagger.io/api/v3/pet — body {"name":"Rex","photoUrls":["x"],"status":"available"}
  risk: low · undo: never · expires: 2026-09-24T02:54Z
```

That endpoint returns **4,019 pets, about 120,000 tokens**. A typical MCP wrapper would put
all of it in the model's context. YEA gives the model what fits its budget and a
handle for the rest. Wrapped writes are marked `undo: never`, because generic REST calls
can't be reversed, so they're never auto-committed.

Combine it with the MCP bridge and any REST API gets previews, budgets and consent inside
Claude Code:

```sh
yea openapi ./openapi.json --header "Authorization: Bearer $API_TOKEN" --port 7447 &
claude mcp add my-api -- npx @yea-protocol/cli mcp yea://127.0.0.1:7447
```
<!-- #endregion openapi -->

## Use it from Claude Code today


<!-- #region claude-code -->
The bridge exposes YEA services as an MCP server, so every MCP client can use them now.
Each capability is its own tool (`calendar_reschedule`, `shop_order`, …), plus `yea_consent`,
`yea_undo` and `yea_expand`. Tool results are Lens.

**Claude Code plugin** (bundles the MCP server and a skill that teaches consent etiquette):

```text
/plugin marketplace add yea-protocol/yea
/plugin install yea@yea
```

**Any tool, one command.** This creates an agent key and registers the bridge (plus a short
agent-instructions block) with every AI tool it finds:

```sh
npx @yea-protocol/cli install                    # or --target claude-code,cursor,codex,gemini,vscode,windsurf,claude-desktop
npx @yea-protocol/cli add https://shop.example/yea   # add services; the bridge picks them up on restart
npx @yea-protocol/cli doctor                     # check keys, grants, services, registration
```

Tools that change things are marked `destructiveHint`; don't auto-approve them in your tool.
The service decides what the agent's grant covers. Anything over it comes back with a consent
code: you run `yea approve <code>` where your principal key is, which shows the exact action
and needs an interactive terminal, and paste the printed consent back to the agent. The model
can't approve for itself, and the bridge never signs anything.

### Keep the principal key away from the agent

Your *principal* key signs your policy and your approvals, so everything rests on it.
`yea install` therefore creates only the agent's key. Create the principal on another
device or OS user and send the agent a grant:

```sh
# on your phone/laptop/other user (holds the principal key)
yea init && yea grant --to <agent key> --svc shop.example --risk low --each spend=25.00USD --total spend=100.00USD --exp 30d
# on the agent's machine
yea grant-import <token>
```

To try things quickly on one machine, use `yea install --with-principal`. Be aware that
an agent with shell access (Claude Code has it) could then read the key. Pair `--each` with
`--total`: a per-action limit alone can be dodged by splitting a purchase, and `--total`
bounds the sum.
<!-- #endregion claude-code -->

## How it compares

| | REST / HTTP APIs | MCP | **YEA** |
|---|---|---|---|
| Unit of interaction | resource (CRUD) | tool call (usually wraps an endpoint) | **intent → proposal → commit** |
| Preview before side effects | rare, per-API (dry-run flags) | tool annotations (`destructiveHint` …) as hints only; no effect preview | **✓** effects, what it uses, risk and undo window on every proposal, bound by hash |
| Undo | per-API, if at all | not in the protocol | **✓** a protocol verb with declared windows |
| Delegation | API keys, OAuth scopes (resource-scoped) | OAuth at the transport | **✓** attenuable capability chains: limits on anything an action uses, risk ceilings, sub-agent delegation, offline verification |
| Human approval | app-specific | elicitation (not bound to an action) | **✓** a consent grant signed over the exact proposal hash |
| Context budget | pagination / field selection, per-API | list pagination only | **✓** every reply fits the requested budget, with `EXPAND` for the rest |
| Model-facing format | JSON | text or structured content, per server; no canonical form | **✓** Lens: canonical, compact, byte-identical across implementations |
| Errors | status codes, RFC 9457 problem details | JSON-RPC codes, `isError` plus free text | **✓** machine-applicable fixes, and `CLARIFY` for ambiguity |
| Idempotency and replay | per-API (`Idempotency-Key`) | `idempotentHint` (hint only) | **✓** commits are idempotent; proofs are time-bound and key-bound |

YEA doesn't replace MCP's role as an integration layer. The bridge runs *on* MCP.
What YEA replaces is the thing MCP servers wrap: an API designed for code rather than
for delegated agents.

## What's in this repo

| Path | What |
|---|---|
| [`SPEC.md`](SPEC.md) | The protocol, v1 draft |
| [`conformance/`](conformance) | Language-neutral test vectors: canonical JSON, keys, hashes, proofs, grants, Lens and token estimates |
| [`ts/`](ts) | Reference implementation (TypeScript, **zero runtime dependencies**, WebCrypto): service, client, transports, CLI, MCP bridge, OpenAPI adapter |
| [`mcp/`](mcp) | `@yea-protocol/mcp` (unreleased): job tools and `guard()` for TypeScript MCP servers, with approval in the client, a signed policy, consent codes and undo |
| [`python/`](python) | Second implementation (Python), started from the spec and vectors, passing all of them, and interoperating with TS |
| [`examples/`](examples) | Calendar and meal-shop services, plus the narrated demo |
| [`bench/`](bench) | The token benchmark above |
| [`docs/design.md`](docs/design.md) | Why it's built this way: every major decision and the alternatives we rejected |
| [`plugins/`](plugins) · [`server.json`](server.json) | Claude Code plugin marketplace and the MCP registry entry |
| [`site/`](site) | The docs site and browser playground (VitePress) |
| [`deploy/demo/`](deploy/demo) | Hosted demo services on Cloudflare Workers (a Durable Object per agent) |

The two implementations interoperate in both directions over TCP and HTTP. The Python
suite also renders every TypeScript reply and event through its own Lens renderer and
checks the output is byte-identical. Writing the second implementation surfaced real
bugs in the first, including a consent-scoping hole and fail-open caveats, and every
fix went into the spec and vectors. See [design notes](docs/design.md).

```sh
npm install && npm test          # TypeScript: unit, conformance, transports, MCP bridge, TS→Python interop
cd python && uv run pytest       # Python: unit, conformance, Python→TS interop
npm run demo && npm run bench
```

## FAQ

<details>
<summary><b>Isn't this just MCP?</b></summary>

No. MCP standardizes how a model *finds and calls tools*. YEA standardizes what the tool *is*: an outcome-level interface with previews, undo, delegated authority, budgets and a model-native format. The two compose: the bridge serves YEA over MCP.
</details>

<details>
<summary><b>Why a new protocol instead of HTTP conventions?</b></summary>

Previews, consent bound to hashes, capability grants, budgets and Lens have to hold *across every service* to be worth anything to an agent. Conventions layered on HTTP get implemented differently by every API, which is how we got here. YEA can still ride HTTP (the bridge) where infrastructure requires it. Its semantics just don't depend on it. [More →](docs/design.md)
</details>

<details>
<summary><b>How does this relate to A2A or ACP?</b></summary>

They connect agents to agents (A2A) or agents to editors (ACP). YEA connects an agent to a *service it acts on*, with a human's authority attached. An agent reached over A2A could itself expose YEA capabilities, and they don't compete.
</details>

<details>
<summary><b>Does the model need to learn a new format?</b></summary>

No. Lens is designed to be read cold: tables for uniform lists, `~ update`/`+ create`/`> send` effect lines, explicit uses and undo windows. In our [real session](docs/claude-code-session.md) Claude used it correctly with no documentation.
</details>

<details>
<summary><b>Does it only work with Claude?</b></summary>

No. Any model that can call tools works. The bridge speaks MCP, and the protocol is model-agnostic. `test-drive` uses Claude because it's a convenient live demo.
</details>

<details>
<summary><b>Why not JWT or OAuth for delegation?</b></summary>

They answer "who is this?" Agents need "what exactly may this do, for whom, up to how much, until when, and can it hand a narrower slice to a helper?" That's a capability chain (in the lineage of macaroons and Biscuit) with caveats a service can check offline. [More →](docs/design.md#grants)
</details>

<details>
<summary><b>What stops a malicious service from lying about effects?</b></summary>

Nothing in v1, beyond making the lie *explicit and bound*: the commit is tied to the hash of the effects shown, and receipts record what was claimed. Signed receipts (for non-repudiation) are on the [roadmap](docs/design.md#roadmap). Only connect services you'd trust with an API key today.
</details>

<details>
<summary><b>Is it production-ready?</b></summary>

Not yet. It's a v1 draft with two conformant implementations, ~240 tests, and an adversarial security audit whose 15 findings are all fixed and covered by regression tests ([details](docs/design.md#security-review)). The reference services keep state in memory. Feedback on the spec is the most valuable contribution right now.
</details>

## Roadmap

- [x] Spec v1 draft, two conformant implementations, conformance vectors
- [x] MCP bridge, `install` for 7 AI tools, Claude Code plugin, OpenAPI adapter and presets
- [x] Adversarial security audit (15 findings fixed)
- [ ] Revocation lists and signed receipts
- [ ] `HOLD`: multi-service atomic commits (flight + hotel, or neither)
- [ ] More presets (Jira, Cloudflare, …) and reversible wrapped writes (undo mappings)
- [ ] Go and Rust implementations. [Help wanted](CONTRIBUTING.md)

## Community

- **Questions and ideas:** [GitHub Discussions](https://github.com/yea-protocol/yea/discussions)
- **Spec feedback and bugs:** [issues](https://github.com/yea-protocol/yea/issues/new/choose) (there's a spec-feedback template)
- **Security:** report privately via [SECURITY.md](SECURITY.md)
- **Contributing:** see [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md). New implementations and presets are the most wanted

If you use YEA in research, please cite it ([CITATION.cff](CITATION.cff)).

## License

Apache-2.0. The spec is free to implement.
