# @yea-protocol/mcp

**Guard a risky tool in your TypeScript MCP server with one call.** Before the tool runs, your
server sends the client its plan as a form (MCP form elicitation), and the tool runs only when
the form comes back with the right phrase typed in: approval in the client. The plan is your
server's, computed from the call's input, and it fails closed. A form proves only what the
client attests, so plans that need a signature go at `risk: 'high'`, which replaces the form
with a consent code for the person to sign with `yea approve`, outside the chat
([what an approval proves](https://github.com/yea-protocol/yea/blob/main/docs/framework/SPEC-approval.md#what-an-approval-proves)).

> **Unreleased:** `@yea-protocol/mcp` isn't on npm yet, so this install fails for now. Until the
> release, install from the repo, as the
> [guide's first step](https://yea-protocol.github.io/yea/guide/mcp-typescript#1-install) shows.

```sh
npm i @yea-protocol/mcp @yea-protocol/sdk @modelcontextprotocol/server zod@4 tsx
```

<!-- snippet: examples/guard-quickstart.ts#quickstart -->
```ts
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { type Approvals, yea } from '@yea-protocol/mcp';
import * as z from 'zod';

export function createServer(approvals: Approvals): McpServer {
  const info = { name: 'mail', version: '1.0.0' };
  const server = new McpServer(info, approvals.serverOptions());
  // Your tool, registered as usual. This one only logs.
  const sendEmail = server.registerTool(
    'send_email',
    {
      description: 'Send an email',
      inputSchema: z.object({ to: z.string(), subject: z.string() }),
    },
    ({ to, subject }) => {
      console.error(`email ${to}: ${subject}`); // stdout is the MCP transport

      return { content: [{ type: 'text', text: `sent to ${to}` }] };
    },
  );

  // One call: now it shows its plan and waits for approval before it runs.
  approvals.guard(server, sendEmail, {
    describe: (input) => ({
      summary: `Email ${String(input.to)}: ${String(input.subject)}`,
      effects: [{ op: 'send', target: String(input.to) }],
    }),
    confirmWith: (_plan, input) => String(input.to), // type the recipient
  });

  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const approvals = yea({ name: 'mail', transport: 'stdio' }); // once per process

  serveStdio(() => createServer(approvals));
}
```

Save it as `server.ts`, and in that folder add it to Claude Code with
`claude mcp add mail -- npx tsx server.ts`. Then ask Claude to email ana@example.com about the
Q3 report. Before anything is sent, Claude Code shows the plan, such as
*Email ana@example.com: Q3 report*, and a field that says *Type "ana@example.com" to approve*.
It needs no keys, policy or account to set up.

## Next

- **The guide**, [Add YEA to your MCP server](https://yea-protocol.github.io/yea/guide/mcp-typescript),
  adds undo, a signed policy that lets undoable plans run on their own, and consent codes for
  clients that can't show forms.
- **The spec** is [SPEC-mcp-ts.md](https://github.com/yea-protocol/yea/blob/main/docs/framework/SPEC-mcp-ts.md),
  and [SPEC-approval.md](https://github.com/yea-protocol/yea/blob/main/docs/framework/SPEC-approval.md)
  for how a call is approved.
- **In Python**, the same server uses [`yea-mcp`](https://pypi.org/project/yea-mcp/).
- **The bridge** behind `yea mcp` is here too, as `@yea-protocol/mcp/bridge`; the
  [`yea` command](https://www.npmjs.com/package/@yea-protocol/cli) runs it.

## License

Apache-2.0
