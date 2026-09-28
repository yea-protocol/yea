/** An AI tool `yea install` can register the MCP bridge with, and the JSON-config kind most of them are. */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { platform } from 'node:os';
import { dirname } from 'node:path';
import { removeBlock, writeBlock } from './instructions.js';

const BRIDGE = {
  command: 'npx',
  args: ['-y', '@yea-protocol/cli', 'mcp'],
};

export interface Scope {
  local: boolean;
  cwd: string;
}

export interface Target {
  name: string;
  detect(): boolean;
  /** Returns what was done, one line per change. */
  install(s: Scope): string[];
  uninstall(s: Scope): string[];
  installed(s: Scope): boolean;
}

export const has = (cmd: string) => {
  try {
    execFileSync(platform() === 'win32' ? 'where' : 'which', [cmd], {
      stdio: 'ignore',
    });

    return true;
  } catch {
    return false;
  }
};

/** An MCP client config file: top-level sections, one of which maps server names to entries. */
type JsonConfig = Record<string, Record<string, unknown> | undefined>;

const readJson = (file: string): JsonConfig => {
  if (!existsSync(file)) {
    return {};
  }

  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new Error(
      `${file} isn't valid JSON; fix it or add the server by hand`,
    );
  }
};

/** A tool whose MCP servers live in a JSON config file under `key`. */
interface JsonTargetOptions {
  name: string;
  /** The JSON config file. */
  file: (s: Scope) => string;
  detect: () => boolean;
  /** Where to write agent instructions, if the tool reads any. */
  block?: (s: Scope) => string;
  /** The config key holding MCP servers (default `mcpServers`). */
  key?: string;
  /** Extra fields for the server entry. */
  extra?: Record<string, unknown>;
}

export function jsonTarget({
  name,
  file,
  detect,
  block,
  key = 'mcpServers',
  extra = {},
}: JsonTargetOptions): Target {
  return {
    name,
    detect,
    installed: (s) => !!readJson(file(s))[key]?.yea,
    install: (s) => {
      const f = file(s);
      const cfg = readJson(f);

      cfg[key] = { ...(cfg[key] ?? {}), yea: { ...extra, ...BRIDGE } };
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, `${JSON.stringify(cfg, null, 2)}\n`);

      const b = block?.(s);

      return [
        `MCP server "yea" → ${f}`,
        ...(b ? [`agent instructions → ${writeBlock(b)}`] : []),
      ];
    },
    uninstall: (s) => {
      const out: string[] = [];
      const f = file(s);
      const cfg = readJson(f);

      const servers = cfg[key];

      if (servers?.yea) {
        delete servers.yea;
        writeFileSync(f, `${JSON.stringify(cfg, null, 2)}\n`);
        out.push(`removed "yea" from ${f}`);
      }

      const b = block?.(s);

      if (b && removeBlock(b)) {
        out.push(`removed instructions from ${b}`);
      }

      return out;
    },
  };
}
