---
editLink: false
---

# Wrap any REST API

<!--@include: ../../README.md#openapi-->

## How operations map

| OpenAPI operation | YEA capability | What the model sees |
|---|---|---|
| `GET` | `ASK` | The response as Lens, fitted to the budget, with `EXPAND` handles for the rest |
| `POST` | `INTENT`, effect `create` | A proposal showing the exact request: method, URL and body |
| `PUT`, `PATCH` | `INTENT`, effect `update` | The same, as an update |
| `DELETE` | `INTENT`, effect `delete`, risk `medium` | The same, as a delete |

Nothing is sent upstream until `COMMIT`. Wrapped writes are irreversible (`undo: never`), so they are never auto-committed, and grants, limits and consent apply unchanged. Upstream errors become YEA errors.

## Options

```sh
yea openapi <spec.json|url> [--base <url>] [--header "K: V"] [--id <service id>] [--prefix <name>] [--port 7447] [--http 8080]
```

| Flag | Meaning |
|---|---|
| `--base` | The API's base URL. Defaults to the spec's first server |
| `--header` | A header sent on every upstream call, such as credentials. Repeatable. Never shown to the model |
| `--id` | The service id, which proofs are bound to. Defaults to the API's host |
| `--prefix` | The capability name prefix. Defaults to a slug of the API's title |
| `--port` | The `yea://` port (7447) |
| `--http` | Also serve the HTTP bridge on this port, at `/yea` |

Writes are authorized for the principals in `YEA_TRUST`, or your own principal key if that's unset.

## From code

```ts
import { fromOpenAPI, loadOpenAPI } from "@yea-protocol/sdk/openapi";
import { listen } from "@yea-protocol/sdk/node";

const spec = await loadOpenAPI("https://petstore3.swagger.io/api/v3/openapi.json");
const svc = fromOpenAPI(spec, {
  baseUrl: "https://petstore3.swagger.io/api/v3",
  headers: { Authorization: `Bearer ${process.env.API_TOKEN}` },
  trust: [PRINCIPAL_KEY],
  risk: (method) => (method === "delete" ? "high" : "low"),
  include: (method, path) => !path.startsWith("/admin"),
});
await listen(svc);
```

## Presets

Some APIs are big enough that exposing every operation would be a bad idea. A preset picks the operations an agent should have, sets the right risk for each, projects responses down to what a model needs, and reads credentials from the environment, where the model never sees them.

```sh
GITHUB_TOKEN=… yea openapi --preset github      # 16 GitHub operations
yea openapi --preset petstore                   # the Swagger Petstore, for trying things
```

### `github`

| Operations | Risk |
|---|---|
| Get the authenticated user, list your repos, get a repo or file, list and get issues and comments, list and get pull requests, search issues and PRs | read (`ASK`) |
| Create or update an issue, comment, add labels | low |
| Open a pull request | medium |
| Merge a pull request | high |

With a policy whose risk ceiling is `low`, such as the starter policy, opening a PR or merging one always asks the human first. Wrapped writes can't be undone, so none of them is ever auto-committed. Without `GITHUB_TOKEN`, the preset still runs and does whatever works anonymously, with GitHub's lower rate limits.

Real output. Reading issues from `microsoft/vscode` comes back as a projected table:

```
→ ASK github.issues_list_for_repo {owner: "microsoft", repo: "vscode", state: "open", per_page: 3}
items[3]{number,title,state,author,labels,comments,updated_at}:
  337706,Terminal text wrapping broken,open,nzakas,"",0,2026-09-24T13:55:52Z
  337705,Preserve customization list scroll position when returning from a detail view,open,NSExceptional,"",0,2026-09-24T13:57:38Z
  337704,"Add a native \"Toggle Line Numbers\" command for the text editor",open,dmoncayo,new release,0,2026-09-24T13:52:45Z
```

A merge is only a proposal until it's committed, and it shows exactly what would be sent:

```
→ INTENT github.pulls_merge {owner: "octo", repo: "demo", pull_number: 42}
1 proposal:
[p_J6IbkIA4] PUT /repos/octo/demo/pulls/42/merge
  ~ update api.github.com/repos/octo/demo/pulls/42/merge — body {}
  risk: high · undo: never · expires: 2026-09-24T14:10Z
```

Presets live in [`ts/src/presets.ts`](https://github.com/yea-protocol/yea/blob/main/ts/src/presets.ts). Contributions of new ones are welcome: each is a spec URL, an allow-list of operations with risks, response projections and the environment variables it reads.
