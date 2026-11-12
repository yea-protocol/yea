# Spec: docs

The pages that turn the framework into adoption. They cover two jobs:
- a five-minute "add YEA to your MCP server" path, in TypeScript and Python;
- a README and landing page that offer that path alongside the protocol, without dropping
  what works today.

Issue: [#42](https://github.com/yea-protocol/yea/issues/42). Map: [README.md](README.md).
Depends on `mcp-ts` (merged) and `mcp-py` (#69), and later `connector-stripe` (#71) and
`bridge` (#73).

## Objective

A developer who already has an MCP server follows a guide, and **within five minutes** has
one risky tool that shows its plan in the person's client and waits for a typed phrase before
it acts. Nothing the model passes to the tool approves it. That first win needs no keys, no
policy and no YEA account: approval in the client works out of the box. It's the form tier,
though, which proves only what the client attests; every page that offers it links to what an
approval proves ([SPEC-approval §9](SPEC-approval.md#what-an-approval-proves)).

The guide then takes them, as separate and clearly marked steps, to:
- undo;
- letting safe things run on their own (a signed policy, which needs the person's key kept
  out of the agent's reach);
- clients that can't ask.

**Users.** MCP server authors (primary); people evaluating YEA for a team; people who want
to implement the protocol.

## Pages

### 1. "Add YEA to your MCP server" (new, two pages)

`site/guide/mcp-typescript.md` and `site/guide/mcp-python.md`, first in the sidebar's Start
section. Both have the same steps. The five-minute claim covers steps 1–3 only.

1. **Install.**
   - TypeScript: `npm i @yea-protocol/mcp @yea-protocol/sdk @modelcontextprotocol/server zod@4`
     (`zod@4`, since `npm i zod` leaves a zod 3 project on zod 3).
   - Python: `uv add yea-mcp`, or `uv add 'yea-mcp[fastmcp]'` for FastMCP, after the release.
     Until then, a repo install needs both distributions, since `yea-mcp` depends on
     `yea-sdk`: `uv add "yea-sdk @ git+https://github.com/yea-protocol/yea#subdirectory=python"
     "yea-mcp @ git+https://github.com/yea-protocol/yea#subdirectory=python/mcp"`.
2. **Guard one tool you already have.** The snippet is a region of the example file, so it
   type-checks. In TypeScript: the full imports (`McpServer`, `serveStdio` from
   `@modelcontextprotocol/server/stdio`, `z`, `node:fs/promises`, `node:path`); the
   `serveStdio` factory; `yea({ name, transport: 'stdio' })`; `approvals.guard(server, tool,
   { describe, confirmWith })`. Inside `describe` and `confirmWith`, the input is untyped
   (`Record<string, unknown>`), so the example converts it with `String(...)`. Python guards
   by name, `approvals.guard(server, "delete_file", describe=…, confirm_with=…)`, and the
   same calls work on a `fastmcp.FastMCP` server (guard a mounted server's tool on the server
   that defines it).
3. **Run it in your client.** `claude mcp add files -- npx tsx server.ts` for Claude Code
   (Node 22.18 or later can run `node server.ts` directly when `package.json` has
   `"type": "module"`), plus the matching config for Cursor and VS Code. The page shows what
   the person then sees: the plan, and a field that says *Type "report.pdf" to approve*.
   **This is the five-minute point.** The page also says:
   - a stderr warning that no principal key is pinned is expected at this stage;
   - the client must support form elicitation (the client table says which do);
   - a tool marked `risk: 'high'`, or an `outOfBand` in `~/.yea/policy.json`, sends it to
     consent codes instead, which need step 5.
4. **Make it undoable.** A `move_to_trash` `job()` whose `apply` moves the file to a trash
   directory, with `revert` putting it back, `undoWindow`, `risk: 'low'`, and the `undo` tool
   it adds.
5. **Let safe things run on their own.** A signed policy lets undoable plans run without
   asking. The page is plain that its strength depends on where the person's **private** key
   lives: whoever can use it can sign policies. So it shows two setups.
   - **The real setup: the key on another OS user or device.**
     1. There, run `yea init`, then `yea whoami`, and copy the principal public key.
     2. On the server's machine, pin it where the server's user can't change it:
        `sudo mkdir -p /etc/yea && echo '<key>' | sudo tee /etc/yea/principal.pub`.
     3. Get the server's id from its start-up log line
        (`yea: service id ed25519:… (name files)`), or from `yea service-id files`.
     4. On the key's side, run `yea grant --to <id> --can move_to_trash --risk low --exp 7d`.
        It prints only the `pg1.` token on stdout. Copy it into a file on the server's
        machine, for example `/Users/me/.config/yea/files.policy`.
     5. In the client config, set `YEA_PRINCIPAL_PUB=/etc/yea/principal.pub` and
        `YEA_POLICY=<absolute path>`. `~` isn't expanded there, so use a full path or
        `$HOME` in a shell.
   - **Trying it on one account (best effort).** The same steps, with `yea init` and
     `yea grant` run on this account. The page says in a callout that an agent running as
     you could then sign its own policy, so this is for trying YEA, not for protecting
     anything.

   Only undoable plans run on their own, so the grant names the step-4 job. The step-2 guard
   never auto-runs unless its `describe` gives an `undoWindow` and it has a `revert`. The page
   says why, and that the grant is signed by the person, not the agent. The Python server's
   id is also `approvals.service_id()`.
6. **Clients that can't ask.** What the consent code looks like, `yea approve`, and why a
   pinned key is needed for it.
7. **Where to next:** the connector example, the security model, the spec.

This needs two small additions, done in this module:
- **`@yea-protocol/mcp` and `yea-mcp`** log `yea: service id <id> (name <name>)` to stderr
  on start-up (parley-80 for TypeScript, parley-05 for Python).
- **`yea service-id <name>`** prints the id from `~/.yea/server/<name>.key`. The format is the
  same for both languages.

### 2. README

The README's first screen is for someone who builds MCP servers (#324); the protocol follows it.

- **Kept unchanged:**
  - the logo, the headline (*HTTP was built for browsers. YEA is built for agents.*) and the
    tagline (*Your Explicit Approval: the open protocol for AI agents acting on behalf of
    people*);
  - the `<!-- #region quickstart|openapi|claude-code -->` markers and the anchors
    (`#numbers`, `#quickstart`, `#client-support`, …), which the site, the guides and
    `llms-full.txt` include or link to. Each region keeps its own "Unreleased" notice, since
    the site shows it without the README's banner.

  Changing the headline or tagline goes to James.
- **The first screen**, after the hero (the logo, headline, tagline, badges and links):
  - a working pitch for the guard path, and why it beats having the model ask: the server
    enforces it, the plan is the server's (computed from the input and bound by hash), and it
    fails closed. Then one sentence on the tiers: a form proves only what the client attests,
    and plans that need a signature go at `risk: 'high'`. It links
    [SPEC-approval §9](SPEC-approval.md#what-an-approval-proves) rather than restating today's
    status, and passes the markdown claim guard (`site/test/markdown-rules.test.mjs`). The
    wording is James's to approve;
  - one "Unreleased" banner, until the release;
  - a "Which package?" row, since this README is also the SDK's npm page;
  - the install line, with `zod@4` (`npm i zod` leaves a zod 3 project on zod 3) and the `tsx`
    the run line uses, then the whole of `examples/guard-quickstart.ts`: a guarded `send_email`
    that only logs, to stderr, since stdout is the MCP transport. It's one region that spans
    the file, so the drift check pins all of it;
  - how to run it in Claude Code (`npx tsx`, from the folder that holds it), and a link to its
    Python twin.

  It makes no time claim until the release's timed run exists. The npm and PyPI badges wait in
  an HTML comment until the packages are published (#319).
- **Then:** the "Get started" table, whose first row is *I have an MCP server*, linking both
  guides; a "Guard your own tools" section (the guide, `risk: 'high'`, the client table); and
  the protocol: its vision, what changes, the demo, the numbers and the quickstart region.
- **Snippets:** a code block in the README is either a region of a tested file, compared by the
  drift check, or isn't there: the SDK's service and agent code is linked, not copied.
- **Client support:** a table with a date. Its columns:
  - the bridge (`yea mcp`): works on the clients listed today, as now;
  - asks in the client (form elicitation): only clients we have actually run, each with its
    date;
  - consent codes: every other client.

  Rows based only on a vendor's docs are marked as such.
- **Numbers:** unchanged, with their caveats. The section says they measure the protocol and
  the bridge, not the framework. The agent-eval section says which tool surface it measured
  (the bridge rebuild changes it, and a re-run needs James's go on cost).
- **Release gate:** until the release that publishes the packages, the install line sits under
  the "Unreleased" banner, which says to install from the repo. The release removes the banner,
  the regions' notices and the badges' comment before the tag (#319): a published version's npm
  and PyPI pages can't change, so the dry run, given the tag, fails while any packed README still
  says the package is unreleased ("Unreleased", "Pre-release", "isn't on npm", "until it's
  published" and the like).
- **ts/README.md** stays synced from it (`scripts/sync-readme.mjs`), so the SDK's npm page is this
  README; it has no page of its own (§6).

### 3. Landing page

The landing (`site/.vitepress/theme/components/Landing.vue`, a layout over `landing/`) offers
the framework as the first of two paths after the hero: "I have an MCP server", marked
unreleased (install from the repo), next to "I'm building an agent or service". The hero is a
proposal slip the visitor approves, then undoes, on the real core, per James's decision of
2026-09-28 (#117). Its headline ("Let your agent act without handing it the keys.", written for
developers, #249) is James's decision of 2026-09-30, and its two buttons ("Try it in the
playground", then "Add it to your MCP server", marked unreleased) are James's decision of
2026-09-29. The benchmark numbers are hand-typed constants in one module, `landing/numbers.ts`.
A check compares the payload figures with `bench/RESULTS.md`, and the live-agent figures with
`bench/agent-eval/RESULTS*.md`, and fails on drift.

### 4. "From REST to YEA" (updated)

`site/guide/service-design.md` keeps its argument (outcome-level jobs instead of endpoints),
with its worked example on the framework API:
- the billing example as `job()` tools in TypeScript, with the Python equivalent in a tab;
- snippets included with the existing relative form, `<<< ../../examples/…#region`, which
  VitePress already resolves, including `# region` markers in Python;
- the protocol-service version (`service().intent(...)`) moves to a closing section for
  people implementing the protocol.

### 5. Smaller pages and wiring

- **The connector page:** `site/guide/stripe.md` (after #71) includes
  `connectors/stripe/README.md`, not-affiliated wording and all. `connectors` joins
  `repoLink`'s regex, `PAGES` and `ignoreDeadLinks` in `site/.vitepress/config.ts`.
- **The integrations page:** per-client setup for a framework server, next to the bridge's.
- **The security model** gains a framework section, pointing to SPEC-approval §9:
  - the principal's **private** key must be out of the agent's reach, or the agent signs its
    own grants;
  - the pinned **public** key must be unwritable by the server's user, or the agent swaps it;
  - why only undoable plans auto-run.
- **`llms.txt` and `llms-full.txt`:** `site/scripts/generate.mjs` learns to expand `<<<`
  imports (today it would copy the raw directive), and lists the framework guides first.
- **The sidebar:** Start → *Add YEA to your MCP server (TS · Python)*, Quickstart, Why YEA,
  Playground … The protocol pages stay under Concepts and Build.

### 6. Package pages

Every other package we publish has a README that is its npm or PyPI page (#323):
`@yea-protocol/mcp`, `@yea-protocol/cli`, `@yea-protocol/stripe`, `yea-sdk` and `yea-mcp`.
- **Its first screen is a package card:** the pitch in a line, the "Unreleased" banner until the
  release, the install line, and its first example.
- **The pitch follows the tiers** ([SPEC-approval §9](SPEC-approval.md#what-an-approval-proves)):
  a form is approval *in the client*, a page that says so links §9, and "the model can't fake
  it" is said of nothing but signed consent, with where the key lives. Each pitch is a working
  line for James to approve.
- **One short example:** `@yea-protocol/mcp` and `yea-mcp` show the README's guard quickstart
  (`examples/guard-quickstart.ts` and its Python twin), not one of their own. The CLI's is
  `examples/cli-quickstart.sh`, the connector's library use `examples/stripe-connector.ts`, and
  `yea-sdk`'s `python/examples/quickstart.py`, each run by a test.
- **Links are absolute,** since npm and PyPI can't follow a relative one: to its guide on the
  site and to its SPEC on GitHub. `repoLink` keeps a link to the site on the site, for the two
  READMEs the site includes (`python/README.md` and `connectors/stripe/README.md`), which keep
  their guide content below the card.

## Owners

| Work | Owner |
|---|---|
| TypeScript guide, `examples/mcp-quickstart.ts`, the service-id log line and `yea service-id`, "From REST to YEA", README, the security section | parley-80 |
| Python guide, `python/mcp/examples/mcp_quickstart.py`, Landing, the sidebar, `generate.mjs`, the connector page and wiring, the integrations page | parley-05 |

## Testing

- **The examples are tests.**
  - `examples/mcp-quickstart.ts` gets a test in `mcp/test/` that drives the guarded tool
    through ask, the typed phrase and run, and the job through undo and a consent code for a
    client that can't ask, using the in-memory clients. `examples/package.json` gains
    `@yea-protocol/mcp`, `@modelcontextprotocol/server` and `zod`. The root `npm test` runs
    it.
  - `python/mcp/examples/mcp_quickstart.py` lives with `yea-mcp`, whose environment has
    `mcp`, and gets a test in its pytest suite, which CI already runs. Python region markers
    are `# region name` / `# endregion name`, imported from site/ as
    `<<< @/../python/mcp/examples/mcp_quickstart.py#name`.
  - The README's quickstart, `examples/guard-quickstart.ts`, and its Python twin,
    `python/mcp/examples/guard_quickstart.py`, each get a test (`mcp/test/guard-quickstart.test.ts`,
    `python/mcp/tests/test_guard_quickstart.py`) that drives ask, a wrong phrase, the typed
    phrase and the run, checks that three wrong phrases or a client without forms send nothing,
    and that the handler writes nothing to stdout. The TypeScript test also starts the file as
    its own process over stdio, which reaches the lines that start it (on Node 22.18 or later,
    so it skips on Node 20).
- **Drift checks** in CI:
  - every README's snippets against the examples' regions (`scripts/check-readmes.mjs`), for the
    README and each package page: a fenced code block (backticks or tildes, under a list item
    or in a quote, in any language but shell, config, output or a diagram) is a pinned region or
    isn't there, and a package page also installs its package outside a comment or a banner,
    links its own guide and SPEC absolutely (and both exist), and has no relative link outside
    code (fenced or indented) in an inline link, a reference definition, or an HTML `src`,
    `srcset` or `href`;
  - the release dry run: every npm tarball carries a README, and, given a tag, no packed README
    (npm's or an sdist's) says the package is unreleased;
  - the install and run lines adopters follow (`site/test/instructions.test.mjs`): zod pinned
    to 4, `node server.ts` only with `"type": "module"`, the README's quickstart installing what
    it imports and runs, and a page promising code only when the README region it includes has
    some;
  - the landing's numbers (`landing/numbers.ts`) against `bench/RESULTS.md` and
    `bench/agent-eval/RESULTS*.md`.
- **The site builds** (`npm run site`, already in CI). Relative links are ignored by the
  dead-link check today, so that check only covers site pages.
- **Five minutes, measured honestly.**
  - `scripts/walkthrough.sh` (not in CI) checks correctness only. It packs the packages
    (`npm pack`, `uv build`), installs them into a fresh temp project, adds the guide's
    snippets, and runs them against an in-memory client.
  - The five-minute claim comes from a timed, recorded run by someone who hasn't used YEA,
    from a clean machine to a guarded tool asking in Claude Code. It's repeated before each
    release, and its time is noted on the release checklist.
- **Numbers:** any figure on the pages comes from `bench/` or is removed.

## Boundaries

- **Always:**
  - snippets come from files CI runs, or are checked against them;
  - claims about clients and numbers are dated and linked;
  - the Stripe pages carry the not-affiliated wording.
- **Ask first:**
  - changing the headline, the tagline or the landing hero;
  - publishing install lines before the packages are published;
  - any comparison claim against another product.
- **Never:**
  - a pronunciation note;
  - Calendly as an example;
  - a figure that isn't reproducible;
  - "works with" claims beyond what was tested;
  - a quickstart that passes the principal key inline to make auto-run easier.

## Success criteria

- A person new to YEA follows either guide from install to a guarded tool asking in Claude
  Code in five minutes, in a timed and recorded run.
- Steps 4–6 work as written. The walkthrough script and the example tests pass.
- The README's first screen leads with the framework path, and the protocol path follows it.
  Nothing on it is untrue for today's clients, and every site include still resolves.

## Decisions

Adopted for v0 under the standing go-ahead; any can be reopened.

1. **Ask first, policy later.** The five-minute win is a tool that asks, which needs no keys.
   Auto-run needs a pinned key and a signed grant, and the guide treats them as a deliberate
   later step.
2. **The headline, tagline and landing hero stay** until James changes them. The framework
   path is added next to them.
3. **Install lines wait for the release,** in both the README and the site. Until then the
   guides say "from the repo", and the switch is on the release checklist.
