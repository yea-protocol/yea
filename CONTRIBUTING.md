# Contributing

YEA is a protocol first. The most valuable contributions right now are:

1. **Spec feedback.** Open an issue quoting the SPEC.md section. Ambiguities are bugs.
2. **New implementations.** Go, Rust, Swift, Kotlin. `conformance/*.json` is the contract:
   pass every vector, then interoperate with `examples/serve.ts` (TS) or
   `python/examples/serve.py`.
3. **Services.** Wrap something real and tell us where the protocol got in your way.

## How work is tracked

Every change starts as a GitHub issue, and every issue ends in a pull request or a note on why it closed.

1. **Open an issue** with a form: *Task* for planned work, *Feature* for a proposal, *Bug*, or *Spec feedback*.
   New issues get `status/triage`.
2. **Triage** adds an `area/*` label, a priority (`priority/P0` now, `P1` next, `P2` later) and a milestone,
   then moves it to `status/ready`. A task is ready when its *Done when* list can be checked by running something.
3. **Claim it** by assigning yourself, switching to `status/in-progress`, and commenting that you've started.
4. **Open a pull request** from a branch named `<issue>-<slug>` (for example `42-rename-cli`), with
   `Closes #42` in the description. `main` only changes through pull requests, and CI must pass.
   PRs are squash-merged, so the PR title becomes the commit message: write it in the repo's style
   (`area: what changed`).
5. **Blocked?** Use `status/blocked` and say on what. Anything only a maintainer can do (a decision,
   credentials, publishing, spending money) gets `status/needs-james`.

Big pieces of work get a tracking issue whose body is a checklist of sub-issues, plus a milestone.

## Changing the protocol

Any change to SPEC.md that affects bytes on the wire or Lens output must:

- update the TypeScript reference in `ts/src`,
- regenerate vectors with `cd ts && npm run build && node scripts/vectors.mjs`,
- keep the Python implementation passing (`cd python && uv run pytest`), which runs both interop directions.

CI fails if the committed vectors don't match the reference implementation.

## Dev loop

```sh
npm install && npm run build && npm test     # TypeScript
cd python && uv run pytest                   # Python
npm run demo && npm run bench
npm run lint && npm run lint:style && npm run lint:structure   # the checks CI runs
```

The docs site (`site/`, built with `npm run site`) follows the design context in `.agents/context/`: PRODUCT.md for who it's for and DESIGN.md for its tokens, which you update when theme tokens change.

## Code style

TypeScript and JavaScript are formatted by [Biome](https://biomejs.dev) (80 columns, single
quotes) and linted by Biome plus [oxlint](https://oxc.rs) for spacing. `npm install` sets up a
pre-commit hook ([lefthook](https://lefthook.dev)) that fixes formatting and spacing in staged
files and blocks the commit on lint errors. `npm run format` and `npm run lint:style:fix` fix
everything by hand.

The rules exist to make the code easy for people to read:

- **Blank lines separate kinds of statements**: imports from declarations, declarations from
  logic, logic from `return`, and around every block. Runs of the same kind stay together, so
  a function's shape shows before you read it.
- **Small functions.** A function stays under 50 lines, under Biome's cognitive-complexity
  limit, and takes at most 4 parameters (use an options object beyond that). When one grows,
  extract a helper named for what it does.
- **Real types.** No `any` (use `unknown` and narrow), and no `!` non-null assertions (check,
  then throw a clear error or return early).
- **Comments say why, not what.** Document declarations with `/** */` so editors show it.
  Inside functions, `//` explains a constraint or a trade-off the code can't show.

Tests and benchmarks are exempt from the length, complexity and non-null rules.

How files are laid out, named and split is in [Code organization](#code-organization).

The commit that first applied the formatting is listed in `.git-blame-ignore-revs`. GitHub
honors it; locally, run `git config blame.ignoreRevsFile .git-blame-ignore-revs`.

## Code organization

The repo should read as one codebase: small single-purpose files, the same patterns everywhere.
This section covers files and folders; [Code style](#code-style) covers what goes inside them.

**One file, one job.**

- A source file holds one concept: a module you can describe in one sentence. That sentence is
  its header.
- Source files stay at or under **300 lines**; aim for about 150. When a file outgrows that,
  split it along a real seam.
- Functions keep the [Code style](#code-style) rules: under 50 lines, under the complexity
  limit, at most 4 parameters.

**Every file opens the same way.**

- TypeScript, JavaScript and Vue: a `/** … */` header before the imports, saying what the file
  holds (and its spec section, when there is one). In a Vue component it opens the `<script>`
  block. Follow the header with the imports or a blank line: a comment directly above a
  declaration is that declaration's JSDoc, not a file header.
- Python: a module docstring as the first statement (only `#` comment lines may come before it).
- Then imports, then types, then constants, then code.

**Names.**

- TypeScript and JavaScript files: lowercase words joined with `-` (`serve-fetch.ts`,
  `key-file.ts`). Python modules: `snake_case`. Vue components: `PascalCase.vue`.
- A name says what the file holds, not how it's used (`consent.ts`, not `helpers2.ts`).

**Folders follow one pattern.**

- A feature with several files is a folder plus an entry file of the same name beside it:
  `cli.ts` + `cli/`, `call.ts` + `call/`, `bridge.ts` + `bridge/`.
- The entry file holds the top-level flow (orchestration, dispatch or the public class) or only
  re-exports; the parts it uses live in the same-named folder. Code in the folder never imports
  its entry file.
- In Python the entry is the package's `__init__.py`, which wires the parts and re-exports; the
  parts are sibling modules in the package.
- A package's public API is only what its `index` re-exports. Modules may export to their
  siblings freely.

**Exports.** Named exports only. No default exports, except where a framework requires one
(VitePress config and theme, Vitest config, Worker entries). No `export *` outside a package
index.

**One home for shared code.**

- Small generic helpers live in the package's `util.ts`; display escaping lives in `text.ts`.
- A helper exists once. When two packages need it, the lower one owns it (`ts` ← `mcp` ←
  `connectors`, `cli`) and the higher one imports it.

**Repeatable shapes.** Files of the same kind look the same:

- a Stripe job module (`jobs/<job>.ts`): its input schema; its types and text helpers, then its
  plan builders (each `X` paired with an `applyX`); `plan()`; the `applyX` functions; `revert()`
  (a note, where the job has none); then the `xJob` factory. Its helpers live in `jobs/<job>/`;
- a service verb: one that needs collaborators or private helpers is a `<Verb>Handler` class
  holding a `Pick<ServiceState>`; a stateless verb is `on<Verb>(state, req, budget)`;
- a CLI command module: one exported `cmdX` per command, sharing `cli/shared.ts`;
- a bridge tool module: the spec, then the handler.

**Tests** are named after the module they cover (`test/refund.test.ts` for
`src/jobs/refund.ts`). Security regressions stay in `security.test.ts`.

**Exempt.** Tests, benchmarks (`bench/`) and the conformance vector generators
(`ts/scripts/vectors.mjs`, `ts/scripts/approval-vectors.mjs`, which are mostly data) are exempt
from the length rules but still need a header and a good name. The `examples/` walkthroughs the
docs embed whole, generated files and the `conformance/` vectors are exempt from all of them.

### How it's checked

`npm run lint:structure` (`scripts/check-structure.mjs`, run in CI and before each commit)
checks every source file for the header, the 300-line limit and the name: its case, plus a list
of known run-together names (`servefetch`, `keyfile`, …). Biome covers exports:
`noDefaultExport`, with overrides for the files a framework needs one in, and `noReExportAll`,
off only for package index files.

Files that broke a rule when the check landed are listed in the script's `RATCHET`, each with
the issue that fixes it. The list only shrinks: the check fails when an unlisted file breaks a
rule, and when a listed violation no longer occurs (fixed, renamed or deleted). Fixing one means removing its entry in
the same PR.
