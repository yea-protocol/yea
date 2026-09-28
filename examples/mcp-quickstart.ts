/**
 * A small `files` MCP server with YEA approval: the example in the "Add YEA to your MCP server"
 * guide (site/guide/mcp-typescript.md). Its regions are included in the guide and the README,
 * and mcp/test/quickstart.test.ts drives them with in-memory clients.
 *
 *   npx tsx examples/mcp-quickstart.ts          # or, on Node 22.18 or later: node …
 *
 * Paths are relative to FILES_ROOT (default: the working directory), and never leave it.
 */
// #region imports
import { randomUUID } from 'node:crypto';
import { link, mkdir, rename, rm, unlink } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { type Approvals, yea } from '@yea-protocol/mcp';
import * as z from 'zod';

// #endregion imports

/** `path` resolved inside `root`; a path that would leave it is refused. */
function inside(root: string, path: string): string {
  const full = resolve(root, path);
  const rel = relative(root, full);

  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`${path} is outside ${root}`);
  }

  return full;
}

const trashDir = (root: string) => join(root, '.trash');

/** Move a file into the trash under a fresh name, and say where it went. */
async function trashFile(root: string, path: string) {
  const trashedAs = join('.trash', `${randomUUID()}-${basename(path)}`);

  await mkdir(trashDir(root), { recursive: true });
  await rename(inside(root, path), join(root, trashedAs));

  return { path, trashedAs };
}

/** Put a trashed file back. It refuses, and changes nothing, if a new file took its place. */
async function restoreFile(root: string, path: string, result: unknown) {
  const trashedAs = (result as { trashedAs?: unknown } | null)?.trashedAs;

  if (typeof trashedAs !== 'string') {
    throw new Error('this receipt has no trashed file');
  }

  const from = inside(trashDir(root), relative('.trash', trashedAs));

  // link fails if the destination exists, where rename would overwrite it.
  await link(from, inside(root, path));
  await unlink(from);
}

/** The `move_to_trash` job: the undoable way to get rid of a file. */
function addMoveToTrash(server: McpServer, approvals: Approvals, root: string) {
  // #region job
  approvals.job(server, 'move_to_trash', {
    description: 'Move a file to the trash. It can be undone for a day.',
    inputSchema: z.object({ path: z.string() }),
    risk: 'low',
    plan: ({ path }) => [
      {
        summary: `Move ${path} to the trash`,
        effects: [
          { op: 'update', target: `file/${path}`, detail: 'moved to .trash' },
        ],
        undoWindow: 86_400, // one day, in seconds
        apply: () => trashFile(root, path),
      },
    ],
    // With revert and an undoWindow, the plan is undoable: YEA adds an `undo` tool.
    revert: ({ input, result }) => restoreFile(root, input.path, result),
  });
  // #endregion job
}

/** A fresh server with both tools. The SDK may call the factory more than once. */
export function createServer(
  approvals: Approvals,
  root = process.env.FILES_ROOT ?? process.cwd(),
): McpServer {
  // #region guard
  const server = new McpServer(
    { name: 'files', version: '1.0.0' },
    approvals.serverOptions(), // lets YEA verify the approval state it sends round
  );

  // The tool you already have, registered as usual.
  const deleteFile = server.registerTool(
    'delete_file',
    {
      description: 'Delete a file for good',
      inputSchema: z.object({ path: z.string() }),
    },
    async ({ path }) => {
      await rm(inside(root, path));

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
  // #endregion guard

  addMoveToTrash(server, approvals, root);

  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  // #region serve
  const approvals = yea({ name: 'files', transport: 'stdio' }); // once per process

  serveStdio(() => createServer(approvals));
  // #endregion serve
}
