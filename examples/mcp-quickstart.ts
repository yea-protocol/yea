/**
 * A small `files` MCP server with YEA approval: the example in the "Add YEA to your MCP server"
 * guide (site/guide/mcp-typescript.md). The guide shows its regions in order (the README copies
 * `guard`), and mcp/test/quickstart.test.ts drives them with in-memory clients.
 *
 *   npx tsx examples/mcp-quickstart.ts          # or, on Node 22.18 or later: node …
 */
// #region imports
import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, rename, rm, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { type Approvals, yea } from '@yea-protocol/mcp';
import * as z from 'zod';
// #endregion imports

import { pathToFileURL } from 'node:url';

// #region guard
/** Your existing tool, registered as usual, then guarded. */
function addDeleteFile(server: McpServer, approvals: Approvals) {
  const deleteFile = server.registerTool(
    'delete_file',
    {
      description: 'Delete a file for good',
      inputSchema: z.object({ path: z.string() }),
    },
    async ({ path }) => {
      await rm(path);

      return { content: [{ type: 'text', text: `deleted ${path}` }] };
    },
  );

  // One call: now it shows its plan and asks the person before it runs.
  approvals.guard(server, deleteFile, {
    describe: (input) => ({
      summary: `Delete ${String(input.path)}`,
      effects: [{ op: 'delete', target: `file/${String(input.path)}` }],
    }),
    // The person types the file's name to approve.
    confirmWith: (_plan, input) => basename(String(input.path)),
  });
}
// #endregion guard

// #region job
/** A job written for YEA: the undoable way to get rid of a file. */
function addMoveToTrash(server: McpServer, approvals: Approvals) {
  approvals.job(server, 'move_to_trash', {
    description: 'Move a file to the trash. It can be undone for a day.',
    inputSchema: z.object({ path: z.string() }),
    risk: 'low',
    // plan() only reads. revert() can't put back a directory, so refuse one here.
    plan: async ({ path }) => {
      const file = resolve(path);

      if (!(await lstat(file)).isFile()) {
        throw new Error(`${path} is not a regular file`);
      }

      return [
        {
          summary: `Move ${path} to the trash`,
          effects: [
            { op: 'update', target: `file/${path}`, detail: 'moved to .trash' },
          ],
          undoWindow: 86_400, // one day, in seconds
          apply: async () => {
            const trash = join(dirname(file), '.trash');
            const trashedAs = join(trash, `${randomUUID()}-${basename(file)}`);

            await mkdir(trash, { recursive: true });
            await rename(file, trashedAs);

            return { file, trashedAs }; // what revert() gets back as `result`
          },
        },
      ];
    },
    // With revert and an undoWindow, the plan is undoable: YEA adds an `undo` tool.
    revert: async ({ result }) => {
      const { file, trashedAs } = result as { file: string; trashedAs: string };

      // link() fails, and changes nothing, if a new file took the old one's place.
      await link(trashedAs, file);
      await unlink(trashedAs);
    },
  });
}
// #endregion job

// #region serve
/** A fresh server each time: the SDK may call the factory more than once. */
export function createServer(approvals: Approvals): McpServer {
  const server = new McpServer(
    { name: 'files', version: '1.0.0' },
    approvals.serverOptions(), // lets YEA verify the approval state it sends round
  );

  addDeleteFile(server, approvals);
  addMoveToTrash(server, approvals); // step 4

  return server;
}
// #endregion serve

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  // #region start
  const approvals = yea({ name: 'files', transport: 'stdio' }); // once per process

  serveStdio(() => createServer(approvals));
  // #endregion start
}
