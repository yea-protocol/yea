# AGENTS.md

Guidance for AI coding agents (and humans) working in this repo.

## Layout
- `SPEC.md`: the protocol. It is the source of truth; code follows it.
- `conformance/*.json`: language-neutral test vectors generated from the TS reference (`ts/scripts/vectors.mjs`).
- `ts/`: TypeScript reference implementation (npm `@yea-protocol/sdk`). Zero runtime dependencies. `src/` holds the core, `src/cli.ts` the CLI's dispatcher (`run(argv)`) and `src/cli/*.ts` its commands, `src/tools.ts` the generic tools of `yea test-drive`, and `src/openapi.ts` the OpenAPI adapter.
- `cli/`: the `yea` command (npm `@yea-protocol/cli`), a thin package over the SDK's `./cli` export. The CLI's code lives in `ts/src/cli.ts` (dispatcher, `run(argv)`) and `ts/src/cli/*.ts`, except `yea mcp` (`cli/bin/mcp.js`).
- `mcp/`: `@yea-protocol/mcp`, job tools for the TypeScript MCP SDK, and the bridge behind `yea mcp` (`mcp/src/bridge.ts`, exported as `@yea-protocol/mcp/bridge`).
- `python/`: second implementation (PyPI `yea-sdk`, import `yea`).
- `examples/`, `bench/`, `site/` (VitePress docs and playground), `deploy/demo/` (Cloudflare Worker).

## Rules
1. **Spec first.** Anything that changes bytes on the wire or Lens output needs a SPEC.md edit, regenerated vectors (`cd ts && npm run build && node scripts/vectors.mjs`), and passing TS and Python suites. CI fails if the vectors drift.
2. **Parity.** A protocol change lands in both `ts/` and `python/`. The interop tests (`ts/test/interop-python.test.ts`, `python/tests/test_interop.py`) must pass in both directions.
3. **Security.** Unknown or malformed caveats fail closed. Never add a path that signs with the principal key on an agent's behalf. Every security fix gets a regression test: in `ts/test/security.test.ts` for the SDK, and in `mcp/test/bridge-security.test.ts` for the bridge.
4. **Zero dependencies** in `ts/` at runtime. Dev dependencies are fine. `@anthropic-ai/sdk` is an optional peer used only by `yea test-drive`.
5. **Readable code.** `npm run lint` and `npm run lint:style` must pass. Split long or complex functions into named helpers; no `any` and no `!` assertions. See [CONTRIBUTING.md](CONTRIBUTING.md#code-style), and [Code organization](CONTRIBUTING.md#code-organization) for how files are laid out (`npm run lint:structure`).
6. **Honest numbers.** Benchmarks are reproducible (`npm run bench`) and published with caveats. Don't cherry-pick.
7. **Work from issues.** Pick up `status/ready` issues in your area, claim them (assignee, `status/in-progress`, a comment naming your session), and link the PR with `Closes #n`. Don't start untracked work: open a Task first. Put decisions and anything needing credentials or money on `status/needs-james` instead of guessing.
8. **One worktree per session.** Sessions share a clone, so never switch branches in the main checkout. Use `git worktree add --no-track -b <issue>-<slug> ../yea-<issue> origin/main`, then `npm ci` in it (so the pre-commit hook and tests run), `git push -u origin HEAD`, work and open the PR there, then `git worktree remove` it after merge.
9. **Pull requests only.** `main` is protected: push a branch, open a PR, let CI pass, then squash-merge (`gh pr merge --squash --delete-branch`). Merge your own PR only when CI is green and the *Done when* list is checked.

## Commands
```sh
npm install && npm run build && npm test     # TS: unit, conformance, security, interop
cd python && uv run pytest                   # Python
npm run lint · npm run lint:style           # Biome + oxlint (CI runs both)
npm run demo · npm run bench · npm run site  # demo, benchmark, docs site
```
