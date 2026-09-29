/**
 * A small `files` MCP server with YEA approval: the example in the "Add YEA to your MCP server"
 * guide (site/guide/mcp-typescript.md). The guide shows its regions in order (the README copies
 * `guard`), and mcp/test/quickstart.test.ts drives them with in-memory clients.
 *
 *   FILES_ROOT=~/yea-scratch npx tsx examples/mcp-quickstart.ts     # or, on Node 22.18+: node …
 */
// #region imports
import { randomUUID } from 'node:crypto';
import {
  link,
  lstat,
  mkdir,
  realpath,
  rename,
  rm,
  unlink,
} from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { type Approvals, yea } from '@yea-protocol/mcp';
import * as z from 'zod';
// #endregion imports

import { pathToFileURL } from 'node:url';

// #region root
/**
 * `path` inside `root`, with symlinks resolved. Anything that leads outside is refused, so the
 * tools can't reach the server's own files (its key, its approval store) or yours; so is a
 * symlink as the file itself, so the plan the person approves always names the file that changes.
 */
async function inside(root: string, path: string): Promise<string> {
  const base = await realpath(root);
  const given = resolve(base, path);

  if ((await lstat(given)).isSymbolicLink()) {
    throw new Error(`${path} is a symlink`);
  }

  const full = await realpath(given);
  const rel = relative(base, full);

  if (
    rel === '' ||
    rel === '..' ||
    rel.startsWith(`..${sep}`) ||
    isAbsolute(rel)
  ) {
    throw new Error(`${path} is outside ${base}`);
  }

  return full;
}

/** `path` inside `root`, as `inside`, and a regular file: never a directory. */
async function fileInside(root: string, path: string): Promise<string> {
  const file = await inside(root, path);

  if (!(await lstat(file)).isFile()) {
    throw new Error(`${path} is not a regular file`);
  }

  return file;
}

/**
 * The folder the tools may change: FILES_ROOT, which must exist and must not hold this server's
 * own files, or `delete_file` could remove them.
 */
export async function filesRoot(
  env: NodeJS.ProcessEnv = process.env,
  self = fileURLToPath(import.meta.url),
): Promise<string> {
  const hint =
    'set FILES_ROOT to a folder of files the tools may change, such as "$HOME/yea-scratch"';

  if (!env.FILES_ROOT) {
    throw new Error(`FILES_ROOT is not set: ${hint}`);
  }

  const root = await realpath(env.FILES_ROOT).catch(() => {
    throw new Error(
      `FILES_ROOT ${env.FILES_ROOT} doesn't exist: create it first`,
    );
  });
  const rel = relative(root, await realpath(self));

  if (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) {
    throw new Error(
      `FILES_ROOT ${root} holds this server's own files: ${hint}`,
    );
  }

  return root;
}
// #endregion root

// #region guard
/** Your existing tool, registered as usual, then guarded. */
function addDeleteFile(server: McpServer, approvals: Approvals, root: string) {
  const deleteFile = server.registerTool(
    'delete_file',
    {
      description: 'Delete a file for good',
      inputSchema: z.object({ path: z.string() }),
    },
    async ({ path }) => {
      await rm(await fileInside(root, path));

      return { content: [{ type: 'text', text: `deleted ${path}` }] };
    },
  );

  // One call: now it shows its plan and asks the person before it runs.
  approvals.guard(server, deleteFile, {
    describe: async (input) => {
      await fileInside(root, String(input.path)); // refuse before anyone is asked

      return {
        summary: `Delete ${String(input.path)}`,
        effects: [{ op: 'delete', target: `file/${String(input.path)}` }],
      };
    },
    // The person types the file's name to approve.
    confirmWith: (_plan, input) => basename(String(input.path)),
  });
}
// #endregion guard

// #region job
/** A job written for YEA: the undoable way to get rid of a file. */
function addMoveToTrash(server: McpServer, approvals: Approvals, root: string) {
  approvals.job(server, 'move_to_trash', {
    description: 'Move a file to the trash. It can be undone for a day.',
    inputSchema: z.object({ path: z.string() }),
    risk: 'low',
    // plan() only reads. revert() can't put back a directory, so fileInside refuses one.
    plan: async ({ path }) => {
      const file = await fileInside(root, path);

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
export function createServer(
  approvals: Approvals,
  root: string, // the only folder the tools touch
): McpServer {
  const server = new McpServer(
    { name: 'files', version: '1.0.0' },
    approvals.serverOptions(), // lets YEA verify the approval state it sends round
  );

  addDeleteFile(server, approvals, root);
  addMoveToTrash(server, approvals, root); // step 4

  return server;
}
// #endregion serve

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  // #region start
  const root = await filesRoot().catch((e: Error) => {
    console.error(`files: ${e.message}`); // refuse to start
    process.exit(1);
  });
  const approvals = yea({ name: 'files', transport: 'stdio' }); // once per process

  serveStdio(() => createServer(approvals, root));
  // #endregion start
}
