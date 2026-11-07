// #region quickstart
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
// #endregion quickstart
