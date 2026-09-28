# Spec: docs

The pages that turn the framework into adoption. They cover two jobs. The first is a
five-minute "add YEA to your MCP server" path, in TypeScript and Python. The second is a README
and landing page that lead with that path and keep the protocol as the foundation underneath.

Issue: [#42](https://github.com/yea-protocol/yea/issues/42). Map: [README.md](README.md).
Depends on `mcp-ts` (merged) and `mcp-py` (#69), and later `connector-stripe` (#71) and
`bridge` (#73).

## Objective

A developer who already has an MCP server lands on the README or the site, and within five
minutes has one risky tool that:
- shows its plan before acting;
- asks the person in their client, with a typed phrase;
- can be undone;
- refuses to be approved by the model.

They do this without learning the protocol first. Someone who wants the protocol finds the
spec, SDKs and design one click away.

**Users.** MCP server authors (primary); people evaluating YEA for a team; people who want
to implement the protocol.

## Pages

### 1. "Add YEA to your MCP server" (new, two pages)

`site/guide/mcp-typescript.md` and `site/guide/mcp-python.md`, first in the sidebar's Start
section. Each follows the same shape, in this order:

1. **Install:** `npm i @yea-protocol/mcp @yea-protocol/sdk`, or `uv add yea-mcp`.
2. **Guard one tool you already have**, about 10 lines:
   ```ts
   const approvals = yea({ name: 'files', transport: 'stdio' });

   serveStdio(() => {
     const server = new McpServer({ name: 'files', version: '1.0.0' }, approvals.serverOptions());
     const del = server.registerTool('delete_file', { inputSchema: z.object({ path: z.string() }) },
       async ({ path }) => { await rm(path); return { content: [{ type: 'text', text: `deleted ${path}` }] }; });

     approvals.guard(server, del, {
       describe: ({ path }) => ({ summary: `Delete ${path}`, effects: [{ op: 'delete', target: path }] }),
       confirmWith: (_plan, { path }) => basename(path),
     });

     return server;
   });
   ```
   The page shows what the person then sees in Claude Code: the plan, and a field that says
   *Type "report.pdf" to approve*.
3. **Make it undoable:** a `job()` with a plan, `undoWindow` and `revert`, and the `undo`
   tool it adds.
4. **Let safe things run on their own:** `yea init`, then
   `yea grant --to $(node -e "…serviceId()") --can delete_file --risk low --exp 7d`. The page
   explains that only undoable plans auto-run, and that the grant is signed by the person,
   not the agent.
5. **Clients that can't ask:** what the consent code looks like, and `yea approve`.
6. **Where to next:** the connector example, the security model, the spec.

**Every snippet is real code.** Each page's snippets are regions of an example file
(`examples/mcp-quickstart.ts`, `python/examples/mcp_quickstart.py`), included with VitePress
`<<< @/…#region` imports. CI type-checks and runs them, with an in-memory client driving the
guarded tool through ask, approve and undo, so a page can't show code that doesn't work.

### 2. README

The README leads with the framework and keeps the protocol as the foundation.

- **Kept:** the logo, the tagline (*Your Explicit Approval: the open protocol for AI agents
  acting on behalf of people*) and the demo. The tagline was set with James; any rewording
  goes to him.
- **The first screen** under it has two paths side by side:
  - **Add it to your MCP server:** three lines of the guard snippet, and a link to the
    five-minute guide (TypeScript · Python).
  - **Use or implement the protocol:** the SDKs, the spec and the playground.
- **The "works with" badges** become honest: a short table of which clients ask in-client
  (form elicitation) and which get consent codes, as SPEC-mcp-ts's research found. It's dated
  and linked to the evidence, rather than a row of "works" badges.
- **Numbers:** unchanged, with their caveats. The agent-eval section says which tool surface
  it measured (the bridge rebuild changes it, and a re-run needs James's go on cost).
- **Removed from the top:** CRUD-versus-intents framing that assumes the reader is building a
  protocol service. It moves to "Why YEA".
- **ts/README.md** is still synced from it (`scripts/sync-readme.mjs`).

### 3. Landing page

`site/.vitepress/theme/components/Landing.vue` gets the same two paths, and the guard snippet
as the hero code. Its benchmark numbers stay synced with `bench/RESULTS.md`.

### 4. "From REST to YEA" (updated)

`site/guide/service-design.md` keeps its argument (outcome-level jobs instead of endpoints),
with its worked example on the framework API. The billing example is written as `job()` tools
in TypeScript, with the Python equivalent in a tab. The protocol-service version
(`service().intent(...)`) moves to a closing section for people implementing the protocol.

### 5. Smaller pages

- **The connector page:** `site/guide/stripe.md` (after #71), which includes
  `connectors/stripe/README.md` like the other included READMEs, not-affiliated wording and
  all.
- **The integrations page** (`site/guide/integrations.md`): per-client setup for a framework
  server, next to the bridge's.
- **The security model** (`site/guide/security.md`) gains a framework section:
  - what a pinned principal key protects;
  - what a key file readable by the agent means;
  - why only undoable plans auto-run.

  It points to SPEC-approval §9.
- **`llms.txt` and `llms-full.txt`** (generated) list the framework guides first.
- **The sidebar:** Start → *Add YEA to your MCP server (TS · Python)*, Quickstart, Why YEA,
  Playground … The protocol pages stay under Concepts and Build.

## Owners

| Work | Owner |
|---|---|
| TypeScript guide, `examples/mcp-quickstart.ts`, README, the updated "From REST to YEA" | parley-80 |
| Python guide, `python/examples/mcp_quickstart.py`, site wiring (sidebar, landing, llms.txt, includes) | parley-05 |
| Security and integrations sections | whoever finishes their part first |

## Testing

- **The examples are tests.** `examples/mcp-quickstart.ts` and
  `python/examples/mcp_quickstart.py` run in CI with in-memory clients (ask, approve with the
  phrase, undo; a client that can't ask gets a code).
- **The site builds** (`npm run site`, already in CI). A dead-link check fails the build.
- **The five-minute walkthrough:** a script (`scripts/walkthrough.sh`, not in CI) that packs
  the packages with `npm pack` and `uv build`, installs them into a fresh temp project, pastes
  in the guide's snippets, and runs them. It's run before each release, and its time is noted
  in the release checklist.
- **Numbers:** any figure on the pages comes from `bench/` or is removed.

## Boundaries

- **Always:**
  - snippets come from files CI runs;
  - claims about clients and numbers are dated and linked;
  - the Stripe pages carry the not-affiliated wording.
- **Ask first:**
  - changing the tagline or the headline;
  - publishing the site before the packages are published (the install lines would fail);
  - any comparison claim against another product.
- **Never:**
  - a pronunciation note;
  - Calendly as an example;
  - a figure that isn't reproducible;
  - "works with" claims beyond what was tested.

## Success criteria

- Someone new to YEA can follow either guide, from install to a guarded tool asking in Claude
  Code, in five minutes, measured with the walkthrough script on a clean machine.
- The README's first screen offers the framework path and the protocol path, and nothing on
  it is untrue for today's clients.
- CI runs every snippet on the guides.

## Decisions

Adopted for v0 under the standing go-ahead; any can be reopened.

1. **Guard first, then job().** The fastest win is guarding a tool the author already has.
   Rewriting it as a job with plans and undo is the second step.
2. **The tagline stays** until James rewords it. The repositioning happens in the first screen
   under it, not in the brand line.
3. **The site's install lines wait for the release.** Until then, the guides say "from the
   repo" (a workspace install), and the switch to `npm i` / `uv add` is on the release
   checklist.
