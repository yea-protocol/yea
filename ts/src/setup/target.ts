/** An AI tool `yea install` can register the MCP bridge with, and the JSON-config kind most of them are. */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { platform } from 'node:os';
import { dirname } from 'node:path';
import {
  type BridgeCommand,
  type Placement,
  parseBridge,
} from './bridge-command.js';
import { removeBlock, writeBlock } from './instructions.js';

export interface Scope {
  local: boolean;
  cwd: string;
}

export interface Target {
  name: string;
  detect(): boolean;
  /** Where its config under `s` is: a project file or not, and a desktop app's or not. */
  placement(s: Scope): Placement;
  /** Registers `bridge`; returns what was done, one line per change. */
  install(s: Scope, bridge: BridgeCommand): string[];
  uninstall(s: Scope): string[];
  /**
   * The bridge command registered under `s`, or null if none. Throws a BadEntry if the entry isn't
   * a bridge command, which install replaces, and another error if the config can't be read.
   */
  registered(s: Scope): BridgeCommand | null;
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
  /** Whether `file` is a project file, which may be committed and shared (default: with --local). */
  project?: (s: Scope) => boolean;
  /** A desktop app: opened from the Dock or a launcher, it starts servers without your shell's PATH (default: no). */
  gui?: boolean;
  /** The config key holding MCP servers (default `mcpServers`). */
  key?: string;
  /** Extra fields for the server entry. */
  extra?: Record<string, unknown>;
}

/** The options with their defaults filled in. */
type JsonTargetConfig = Required<Omit<JsonTargetOptions, 'block'>> &
  Pick<JsonTargetOptions, 'block'>;

export function jsonTarget({
  project = (s) => s.local,
  gui = false,
  key = 'mcpServers',
  extra = {},
  ...rest
}: JsonTargetOptions): Target {
  const o: JsonTargetConfig = { ...rest, project, gui, key, extra };

  return {
    name: o.name,
    detect: o.detect,
    placement: (s) => ({ project: o.project(s), gui: o.gui }),
    registered: (s) => {
      const entry = readJson(o.file(s))[o.key]?.yea;

      return entry === undefined ? null : parseBridge(entry);
    },
    install: (s, bridge) => installJson(o, s, bridge),
    uninstall: (s) => uninstallJson(o, s),
  };
}

/** Write `bridge` as the "yea" entry in `o`'s config, and its agent instructions. */
function installJson(
  o: JsonTargetConfig,
  s: Scope,
  bridge: BridgeCommand,
): string[] {
  const f = o.file(s);
  const cfg = readJson(f);

  cfg[o.key] = { ...(cfg[o.key] ?? {}), yea: { ...o.extra, ...bridge } };
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, `${JSON.stringify(cfg, null, 2)}\n`);

  const b = o.block?.(s);

  return [
    `MCP server "yea" → ${f}`,
    ...(b ? [`agent instructions → ${writeBlock(b)}`] : []),
  ];
}

/** Remove the "yea" entry from `o`'s config, and its agent instructions. */
function uninstallJson(o: JsonTargetConfig, s: Scope): string[] {
  const out: string[] = [];
  const f = o.file(s);
  const cfg = readJson(f);
  const servers = cfg[o.key];

  if (servers?.yea) {
    delete servers.yea;
    writeFileSync(f, `${JSON.stringify(cfg, null, 2)}\n`);
    out.push(`removed "yea" from ${f}`);
  }

  const b = o.block?.(s);

  if (b && removeBlock(b)) {
    out.push(`removed instructions from ${b}`);
  }

  return out;
}
