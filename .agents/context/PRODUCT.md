# Product

## Register

product

## Users

The site (https://yea-protocol.github.io/yea/) serves four groups. Most arrive from the README, a
link in a thread, or a search, and read at a desk with an editor or terminal open beside the page.

1. **MCP server authors (primary).** TypeScript or Python developers with a working MCP server who
   want one risky tool to show its plan and ask the person before it acts. They follow a guide
   step by step, copy snippets, and compare what they see with what the page says. Success is a
   guarded tool asking in their client within five minutes.
2. **Developers building or running agents.** People using Claude Code, Cursor, Codex and other
   MCP clients who want their agent to take real actions (book, order, refund) without handing
   it an unrestricted credential. They want to see an exchange work before installing anything,
   which is what the playground and `yea test-drive` are for.
3. **Service and API owners, and protocol implementers.** People making a service agent-ready
   (build a service, wrap an OpenAPI spec, "From REST to YEA") and people porting the protocol to
   another language, who live in the spec, the conformance vectors and the design notes.
4. **Evaluators.** Tech leads, security reviewers and individuals deciding whether to let an
   agent act for them or their team. They are skeptical by default. They read Why YEA, the
   security model and the benchmarks, and look for the catch before they look at the pitch.

## Product Purpose

YEA (Your Explicit Approval) is an open protocol, with SDKs in TypeScript and Python, for AI agents
acting on behalf of people. An agent states an intent. The service replies with proposals that
list their effects up front: what changes, what it uses (money, emails, deletions), its risk and
its undo window. Nothing happens until a commit. The person's signed policy (a grant with scopes,
limits and a risk ceiling) decides what can go ahead without asking; anything over a limit or
irreversible stops for the person, who approves that exact proposal by signing its hash.
Receipts carry an undo window, and UNDO is a verb. Replies fit a token budget and come in Lens, a
compact text format written for models.

The framework is meant to be what people adopt first: plugins for the official MCP SDKs
(`@yea-protocol/mcp` for TypeScript, `yea-mcp` for Python) that add this preview, approve and undo
loop to an existing MCP server one tool at a time. It is unreleased: neither plugin is on npm or
PyPI yet (nor are the SDKs and the `yea` command, per the guides), so the guides install from the
repository and the site must say so wherever it offers that path. The protocol, the CLI and the
bridge (`yea mcp`, which exposes YEA services to any MCP client) sit underneath. The playground is
the one path that needs no install at all.

The site exists to get a developer from "what is this" to a working, guarded action, and to give
an evaluator enough evidence (the spec, the security model, published benchmarks with their
caveats) to trust it. Success: a reader who arrived skeptical either runs the playground or the
quickstart, or leaves with an accurate picture of what YEA does and does not do.

### Surfaces and their register

The default register above is `product`, because nearly every page is read while doing
something: following a guide, checking the spec, driving the playground. One surface overrides it.

| Surface | Register | Why |
|---|---|---|
| Landing (`/`, `Landing.vue`) | brand | First impression and argument. Its job is to make the idea land and be remembered. |
| Why YEA (`/why`) | brand-leaning long-form | An essay. Reading comfort and voice matter more than chrome. |
| Guide, reference, spec, benchmark pages | product | Docs as a tool: familiar navigation, fast search, readable prose and code. |
| Playground (`/playground`) | product | An interactive tool. State, feedback and keyboard use come first. |

### Decided direction (James, 2026-09-28)

- **Light first.** The site follows the reader's OS theme. Pages are designed and reviewed in the
  light theme first, and both themes must meet WCAG AA.
- **The landing lets the visitor say yes.** Its hero is a real proposal the visitor approves,
  then sees the receipt, then undoes, on the real core. The page is ordered by protocol state,
  shows its evidence as one chart with the caveats beside it, and offers two paths: "I have an MCP
  server" (the framework, marked unreleased) and "I'm building an agent or service".
- **One voice in type.** A single family carries all human-facing text; machine output keeps
  its own mono. (Specific fonts live in DESIGN.md.)

## Brand Personality

**Exact, candid, accountable.**

- **Exact.** The site shows the real thing: real Lens output, the real core running in the
  browser, figures that come from `bench/` with their method linked. Precise words over big
  ones.
- **Candid.** It says where YEA costs more, what the benchmark got wrong, and what v1 lacks. The
  honest claim ("the safety comes at roughly no extra cost") beats the flattering one.
- **Accountable.** The subject is consent. The emotional goal is calm confidence: nothing
  happens until you say yes, and you can see exactly what you are saying yes to. The person's
  approval is the climax of every story the site tells.

Voice: plain sentences, short paragraphs, verbs over adjectives, no hype words ("revolutionary",
"autonomous", "unleash"), no em dashes. Speak to developers as peers.

## Anti-references

- **Generic AI-agent startup marketing.** Purple-to-blue gradients, glowing orbs, robot or brain
  imagery, "autonomous agents that do everything for you" copy. YEA is about the opposite: the
  person staying in charge.
- **Crypto and web3 aesthetics.** Neon on black, glitch effects, "trustless" language. Signed
  grants and hashes are real here, and must not read as a token launch.
- **Security fear-marketing.** Padlocks, shields, red alert banners, breach headlines. Safety is
  shown through the exchange, not asserted with icons.
- **SaaS landing templates.** Hero-metric blocks (a big number, a small label, a gradient
  accent), identical three-up feature cards with icons, logo walls of companies that don't use
  it.
- **Decorative terminal costume.** Fake windows with traffic-light dots and glow behind them as
  a shorthand for "developer tool". Show real output because it is the product, not to look
  technical.
- **Overclaiming numbers.** Cherry-picked benchmarks, figures without a method link, "10x"
  anything.
- **Other brands.** Don't imitate the look of any other company, protocol or product, including
  the ones YEA works with (MCP clients, Stripe, model vendors).
- **Never** a note on how "YEA" is pronounced, and never Calendly as an example.

## Design Principles

1. **Show the real exchange.** Every example is real output: Lens a model would read, frames the
   core produced, a session that actually happened. If it can run in the page, it runs in the
   page.
2. **Colour is protocol state.** Amber means proposed and waiting on a person, green means
   committed, red means refused. Colour that means nothing is noise that dilutes the colour that
   does.
3. **Caveats in plain sight.** Numbers sit next to their method and their limits, at the same
   visual weight as the claim.
4. **The yes is the moment.** Approval, consent and undo are where design effort goes first: they
   carry the product's meaning and the reader's trust.
5. **Docs are a tool first.** On guide and reference pages, familiarity, speed, search and
   readable code beat novelty. Distinctiveness belongs on the landing and in the few components
   that carry protocol meaning.

## Accessibility & Inclusion

- WCAG 2.2 AA in both light and dark themes, including code, inline code and Lens colouring.
  Light mode is not a second-class theme.
- State is never conveyed by colour alone: Lens already pairs colour with glyphs (`✓`, `✗`, `~`,
  `>`, `↶`), and badges carry words. Keep it that way for colour-blind readers.
- `prefers-reduced-motion` is honoured everywhere; animated demos render their finished state.
- The playground is fully usable by keyboard and screen reader: real tab and radio semantics,
  visible focus, announcements scoped to the reply, not the whole pane.
- Touch targets of at least 44px on mobile; no horizontal page scroll at 320px and up.
- Readers include non-native English speakers: plain words, short sentences, defined terms.
