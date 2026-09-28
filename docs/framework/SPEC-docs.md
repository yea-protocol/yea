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
one risky tool that shows its plan and asks the person in their client, with a typed phrase,
before it acts. The model can't approve it. That first win needs no keys, no policy and no
YEA account: approval in the client works out of the box.

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
   - TypeScript: `npm i @yea-protocol/mcp @yea-protocol/sdk @modelcontextprotocol/server zod`.
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
3. **Run it in your client.** `claude mcp add files -- node server.ts` for Claude Code, plus
   the matching config for Cursor and VS Code. The page shows what the person then sees: the
   plan, and a field that says *Type "report.pdf" to approve*. **This is the five-minute
   point.**
4. **Make it undoable.** A `job()` whose `apply` moves the file to a trash directory, with
   `revert` putting it back, `undoWindow`, `risk: 'low'`, and the `undo` tool it adds.
5. **Let safe things run on their own.** This takes three things, each explained:
   - **Pin the person's public key where the server can't change it.** For example
     `sudo install -o root -m 644 ~/.yea/principal.pub /etc/yea/principal.pub`, then
     `YEA_PRINCIPAL_PUB=/etc/yea/principal.pub`. A key under your home directory is refused,
     because an agent running as you could swap it. A key on another user or device is
     stronger.
   - **Grant the server a policy.** Get the server's id from the log line it prints at
     start-up (`yea: service id ed25519:…`), or from `yea service-id <name>`. Then run
     `yea grant --to <id> --can delete_file --risk low --exp 7d > ~/.yea/files.policy` and
     set `YEA_POLICY=~/.yea/files.policy`.
   - **Pass both variables in the client config.**

   Only undoable plans run on their own, so the grant names the step-4 job. The step-2 guard
   never auto-runs unless its `describe` gives an `undoWindow` and it has a `revert`. The page
   says why, and that the grant is signed by the person, not the agent. The Python server's
   id is also `approvals.service_id()`.
6. **Clients that can't ask.** What the consent code looks like, `yea approve`, and why a
   pinned key is needed for it.
7. **Where to next:** the connector example, the security model, the spec.

This needs two small additions, done in this module:
- **`@yea-protocol/mcp` and `yea-mcp`** log `yea: service id <id> (name <name>)` to stderr
  on start-up.
- **`yea service-id <name>`** prints the id from `~/.yea/server/<name>.key`. The format is the
  same for both languages.

### 2. README

The README keeps what works, and adds the framework path.

- **Kept unchanged:**
  - the logo, the headline (*HTTP was built for browsers. YEA is built for agents.*), the
    tagline (*Your Explicit Approval: the open protocol for AI agents acting on behalf of
    people*) and the demo;
  - the "Get started" table;
  - the `<!-- #region quickstart|openapi|claude-code -->` markers and the anchors
    (`#numbers`, `#quickstart`, …), which the site and `llms-full.txt` include.

  Changing the headline or tagline goes to James.
- **Added:** a row at the top of the "Get started" table, *I have an MCP server → guard a risky
  tool in five minutes*, linking to the guide. Also a short "Add it to your MCP server"
  section with the guard snippet. That snippet can't use `<<<`, so a check in CI compares it
  with the example file's region and fails on drift.
- **Client support:** the badge row becomes a table with a date. Its columns:
  - the bridge (`yea mcp`): works on the clients listed today, as now;
  - asks in the client (form elicitation): only clients we have actually run, each with its
    date;
  - consent codes: every other client.

  Rows based only on a vendor's docs are marked as such.
- **Numbers:** unchanged, with their caveats. The section says they measure the protocol and
  the bridge, not the framework. The agent-eval section says which tool surface it measured
  (the bridge rebuild changes it, and a re-run needs James's go on cost).
- **Release gate:** the framework section and the `npm i @yea-protocol/mcp` lines merge into
  the README only with the release that publishes the package. Until then, the section says
  "unreleased: install from the repo". The switch is on the release checklist.
- **ts/README.md** stays synced from it (`scripts/sync-readme.mjs`).

### 3. Landing page

`site/.vitepress/theme/components/Landing.vue` gets a framework card next to the protocol
content. The hero (the Lens exchange under the headline) stays unless James changes it. Its
benchmark numbers are hand-typed constants; a check compares them with `bench/RESULTS.md`
and fails on drift.

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
- **Drift checks** in CI:
  - the README snippet against the example's region;
  - `Landing.vue`'s numbers against `bench/RESULTS.md`.
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
- The README's first screen offers the framework path alongside the protocol path. Nothing on
  it is untrue for today's clients, and every site include still resolves.

## Decisions

Adopted for v0 under the standing go-ahead; any can be reopened.

1. **Ask first, policy later.** The five-minute win is a tool that asks, which needs no keys.
   Auto-run needs a pinned key and a signed grant, and the guide treats them as a deliberate
   later step.
2. **The headline, tagline and landing hero stay** until James changes them. The framework
   path is added next to them.
3. **Install lines wait for the release,** in both the README and the site. Until then the
   guides say "from the repo", and the switch is on the release checklist.
