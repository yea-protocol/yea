# Claude Code runs, 2026-11-03

The evidence for the Claude Code row of the [client table](../../../README.md#client-support).
The write-up is in [Integrations, Client runs](../../../site/guide/integrations.md#client-runs).

- **Client:** Claude Code 2.1.317, interactive, in tmux 3.6a on macOS 26.6, in auto permission
  mode, with no `Elicitation` hooks configured.
- **Repo:** commit `8719326`; `@yea-protocol/mcp` 0.1.0, `@modelcontextprotocol/server` 2.3.1,
  zod 4.6.7, Node 22.18.0.
- **Paths:** `<scratch>` is a throwaway folder and `<clone>` the checkout. They, the user name
  and the plan name were replaced in every file; nothing else was edited, apart from trailing
  blank lines.

## The runs

| Folder | Runtime | Revision | What it shows |
|---|---|---|---|
| [`form-v2/`](form-v2) | `MCP_SDK_GENERATION=v2` | 2026-07-28 | the form, three wrong phrases refused, the right one runs |
| [`form-v1/`](form-v1) | `MCP_SDK_GENERATION=v1` | 2025-11-25 | the same, through `elicitation/create` |
| [`codes-v2/`](codes-v2) | `MCP_SDK_GENERATION=v2` | 2026-07-28 | a consent code, `yea approve` refusing a wrong phrase then signing, the call running |
| [`codes-v1/`](codes-v1) | `MCP_SDK_GENERATION=v1` | 2025-11-25 | a consent code, `yea approve`, the call running |
| [`form-unlogged/`](form-unlogged) | the session's default (v2) | not logged | a first run on the unchanged `examples/mcp-quickstart.ts`: screens only |

Each logged folder holds:

- `keys.log`: every keystroke sent, in order. The `Down`, `Enter` after `start` answers Claude
  Code's folder-trust question with "Yes, I trust this folder". Inside the form, the typed text
  fills *Confirm*, then `Down`, `Enter` picks *Accept*.
- `NN-*.txt`: the screen after each step (`tmux capture-pane -p -S -1000`). `07-verbose.txt` is
  Claude Code's transcript view (`ctrl+o`), which shows each tool call and *Allowed by auto mode*.
- `wire.log`: every JSON-RPC line between Claude Code and the server, both ways, and the
  server's stderr, timestamped. The `scratch: negotiated protocol revision` line comes from the
  launcher below.

## How to run it again

The files the tools may change:

```sh
mkdir -p <scratch>/files/docs
echo "Q3 report" > <scratch>/files/docs/report.pdf
echo "meeting notes" > <scratch>/files/docs/notes.txt
YEA_HOME=<scratch>/yea node <clone>/cli/bin/yea.js init      # the principal key, for the codes runs
```

The form runs' MCP config (`form-v1` is the same with its own log path):

```json
{ "mcpServers": { "files": { "type": "stdio", "command": "node",
  "args": ["<scratch>/tee.mjs", "<scratch>/runs/form-v2/wire.log", "node", "<scratch>/files-logged.ts"],
  "env": { "FILES_ROOT": "<scratch>/files", "YEA_HOME": "<scratch>/yea" } } } }
```

The codes runs' config sets the principal key and a home whose `policy.json` is
`{ "outOfBand": "medium" }`, so the medium-risk `delete_file` is never approved in the chat:

```json
{ "mcpServers": { "files": { "type": "stdio", "command": "node",
  "args": ["<scratch>/tee.mjs", "<scratch>/runs/codes-v2/wire.log", "node", "<scratch>/files-logged.ts"],
  "env": { "FILES_ROOT": "<scratch>/files", "YEA_HOME": "<scratch>/yea-codes",
           "PRINCIPAL": "ed25519:xrY_uDTGmLYrSjFm0-fQ6d_iCvWpzyyYlskFQ72XshY" } } } }
```

Then, in tmux, from an empty folder:

```sh
MCP_SDK_GENERATION=v2 claude --strict-mcp-config --mcp-config <scratch>/mcp-form-v2.json
```

and type `Use the files MCP server's delete_file tool to delete docs/report.pdf`. For a code,
approve it in a second pane, then tell Claude Code to call again:

```sh
YEA_HOME=<scratch>/yea YEA_STORE=<scratch>/yea-codes/store node <clone>/cli/bin/yea.js approve <pc1.code>
```

`files-logged.ts`, the launcher. It differs from the example's own start-up in two ways. It logs
the revision the framework sees. And it takes the principal key as `yea()`'s `principal`
option: `YEA_PRINCIPAL_PUB` must name a file the server's OS user can't change, and the run had
no root access to make one.

```ts
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { yea } from '@yea-protocol/mcp';
import { createServer, filesRoot } from '<clone>/examples/mcp-quickstart.ts';

const root = await filesRoot();
const principal = process.env.PRINCIPAL;
const approvals = yea({ name: 'files', transport: 'stdio', ...(principal ? { principal } : {}) });

serveStdio(() => {
  const server = createServer(approvals, root);
  const inner = server.server;
  const negotiated = inner.getNegotiatedProtocolVersion.bind(inner);
  let last: string | undefined;

  inner.getNegotiatedProtocolVersion = () => {
    const v = negotiated();

    if (v !== last) {
      console.error(`scratch: negotiated protocol revision ${v}`);
      last = v;
    }

    return v;
  };

  return server;
});
```

`tee.mjs`, the proxy that writes `wire.log`:

```js
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const [log, cmd, ...args] = process.argv.slice(2);
const note = (tag, line) => appendFileSync(log, `${new Date().toISOString()} ${tag} ${line}\n`);
const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });

process.stdin.on('data', (b) => child.stdin.write(b));
process.stdin.on('end', () => child.stdin.end());
child.stdout.on('data', (b) => process.stdout.write(b));
createInterface({ input: process.stdin }).on('line', (l) => note('client→server', l));
createInterface({ input: child.stdout }).on('line', (l) => note('server→client', l));
createInterface({ input: child.stderr }).on('line', (l) => note('stderr', l));
child.on('exit', (code) => { note('exit', String(code)); process.exit(code ?? 0); });
```
