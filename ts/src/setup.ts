/**
 * `yea install|uninstall`: register the YEA MCP bridge (plus agent instructions) with AI tools, and
 * `yea add/remove/services`: manage the services it exposes (~/.yea/services.json).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { home } from './home.js';

export const BRIDGE = {
  command: 'npx',
  args: ['-y', '@yea-protocol/cli', 'mcp'],
};

// ---- services registry ----
const servicesFile = () => join(home(), 'services.json');

export function listServices(): string[] {
  try {
    const v = JSON.parse(readFileSync(servicesFile(), 'utf8'));

    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function saveServices(urls: string[]) {
  mkdirSync(home(), { recursive: true, mode: 0o700 });
  writeFileSync(
    servicesFile(),
    `${JSON.stringify([...new Set(urls)], null, 2)}\n`,
  );
}

export const addService = (url: string) =>
  saveServices([...listServices(), url]);

export const removeService = (url: string) =>
  saveServices(listServices().filter((u) => u !== url));

// ---- agent instructions (a marker-fenced block; subagents don't see MCP server instructions) ----
const START = '<!-- YEA_START -->',
  END = '<!-- YEA_END -->';

export const AGENT_BLOCK = `${START}
## YEA: acting for the user

Each YEA capability is its own tool (for example \`shop_order\`), plus \`yea_consent\`, \`yea_undo\` and \`yea_expand\`. They act for the user under a policy they signed.
- Read-only tools never change anything. Tools marked destructive do things: call one with what the user asked for. It commits at once when the user's grant allows it (a \`✓\` receipt); otherwise it returns proposals (effects, cost, risk, undo) and nothing has happened.
- Over the grant, each proposal comes with a consent code. Ask the user to run \`yea approve <code>\` where their principal key is and paste the printed consent back, pass it to \`yea_consent\`, then call the same tool again with the same arguments. Never split or restructure a purchase to get under a limit.
- \`proposal: "<id>"\` commits one of the proposals the grant allows; \`preview: true\` only shows proposals. Commit only what the user asked for.
- Offer \`yea_undo\` if they change their mind within the undo window.
${END}
`;

export function writeBlock(file: string): string {
  const cur = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const re = new RegExp(`${START}[\\s\\S]*?${END}\\n?`);
  const head =
    !cur && file.endsWith('.mdc')
      ? "---\ndescription: Using YEA tools on the user's behalf\nalwaysApply: true\n---\n\n"
      : '';
  const next = re.test(cur)
    ? cur.replace(re, AGENT_BLOCK)
    : head +
      cur +
      (cur && !cur.endsWith('\n') ? '\n' : '') +
      (cur ? '\n' : '') +
      AGENT_BLOCK;

  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, next);

  return file;
}

export function removeBlock(file: string): boolean {
  if (!existsSync(file)) {
    return false;
  }

  const cur = readFileSync(file, 'utf8');
  const next = `${cur
    .replace(new RegExp(`\\n?${START}[\\s\\S]*?${END}\\n?`), '\n')
    .trimEnd()}\n`;

  if (next === cur) {
    return false;
  }

  writeFileSync(file, next);

  return true;
}

// ---- clients ----
interface Scope {
  local: boolean;
  cwd: string;
}
interface Target {
  name: string;
  detect(): boolean;
  /** Returns what was done, one line per change. */
  install(s: Scope): string[];
  uninstall(s: Scope): string[];
  installed(s: Scope): boolean;
}

const has = (cmd: string) => {
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

function jsonTarget({
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

const devinDir = () =>
  join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'devin');
const appData = () =>
  process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
const claudeDesktopConfig = () =>
  platform() === 'darwin'
    ? join(
        homedir(),
        'Library',
        'Application Support',
        'Claude',
        'claude_desktop_config.json',
      )
    : platform() === 'win32'
      ? join(appData(), 'Claude', 'claude_desktop_config.json')
      : join(homedir(), '.config', 'Claude', 'claude_desktop_config.json');

export const CLIENTS: Record<string, Target> = {
  // alwaysLoad keeps the tools out of Claude Code's deferred tool search.
  'claude-code': jsonTarget({
    name: 'Claude Code',
    file: (s) =>
      s.local ? join(s.cwd, '.mcp.json') : join(homedir(), '.claude.json'),
    detect: () => has('claude') || existsSync(join(homedir(), '.claude')),
    block: (s) =>
      s.local
        ? join(s.cwd, 'CLAUDE.md')
        : join(homedir(), '.claude', 'CLAUDE.md'),
    extra: { type: 'stdio', alwaysLoad: true },
  }),
  'claude-desktop': jsonTarget({
    name: 'Claude Desktop',
    file: claudeDesktopConfig,
    detect: () => existsSync(dirname(claudeDesktopConfig())),
  }),
  cursor: jsonTarget({
    name: 'Cursor',
    file: (s) =>
      s.local
        ? join(s.cwd, '.cursor', 'mcp.json')
        : join(homedir(), '.cursor', 'mcp.json'),
    detect: () => existsSync(join(homedir(), '.cursor')),
    block: (s) => (s.local ? join(s.cwd, '.cursor', 'rules', 'yea.mdc') : ''),
  }),
  // Windsurf became Devin Desktop; its Cascade agent reads $XDG_CONFIG_HOME/devin/mcp_config.json. Keep the legacy path if that's what exists.
  windsurf: jsonTarget({
    name: 'Windsurf / Devin Desktop',
    file: () =>
      existsSync(join(homedir(), '.codeium', 'windsurf')) &&
      !existsSync(devinDir())
        ? join(homedir(), '.codeium', 'windsurf', 'mcp_config.json')
        : join(devinDir(), 'mcp_config.json'),
    detect: () =>
      existsSync(join(homedir(), '.codeium', 'windsurf')) ||
      existsSync(devinDir()),
  }),
  gemini: jsonTarget({
    name: 'Gemini CLI',
    file: (s) => join(s.local ? s.cwd : homedir(), '.gemini', 'settings.json'),
    detect: () => existsSync(join(homedir(), '.gemini')),
    block: (s) =>
      s.local
        ? join(s.cwd, 'GEMINI.md')
        : join(homedir(), '.gemini', 'GEMINI.md'),
  }),
  vscode: jsonTarget({
    name: 'VS Code',
    file: (s) => join(s.cwd, '.vscode', 'mcp.json'),
    detect: () => has('code'),
    key: 'servers',
    extra: { type: 'stdio' },
  }),
  codex: {
    name: 'Codex CLI',
    detect: () => existsSync(join(homedir(), '.codex')),
    installed: () =>
      existsSync(join(homedir(), '.codex', 'config.toml')) &&
      /^\[mcp_servers\.yea\]/m.test(
        readFileSync(join(homedir(), '.codex', 'config.toml'), 'utf8'),
      ),
    install: (s) => {
      const file = join(homedir(), '.codex', 'config.toml');
      const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
      const out: string[] = [];

      if (!/^\[mcp_servers\.yea\]/m.test(current)) {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(
          file,
          current +
            `${current && !current.endsWith('\n') ? '\n' : ''}\n[mcp_servers.yea]\ncommand = "npx"\nargs = ["-y", "@yea-protocol/cli", "mcp"]\n`,
        );
      }

      out.push(`MCP server "yea" → ${file}`);
      out.push(
        `agent instructions → ${writeBlock(s.local ? join(s.cwd, 'AGENTS.md') : join(homedir(), '.codex', 'AGENTS.md'))}`,
      );

      return out;
    },
    uninstall: (s) => {
      const file = join(homedir(), '.codex', 'config.toml');
      const out: string[] = [];

      if (existsSync(file)) {
        const cur = readFileSync(file, 'utf8');
        // Drop the [mcp_servers.yea] table: its header line and every line up to the next table header.
        const lines = cur.split('\n');
        const i = lines.findIndex((l) => l.trim() === '[mcp_servers.yea]');
        let next = cur;

        if (i >= 0) {
          let j = i + 1;

          while (j < lines.length && !/^\s*\[/.test(lines[j])) {
            j++;
          }

          next = [...lines.slice(0, i), ...lines.slice(j)]
            .join('\n')
            .replace(/\n{3,}/g, '\n\n');
        }

        if (next !== cur) {
          writeFileSync(file, next);
          out.push(`removed [mcp_servers.yea] from ${file}`);
        }
      }

      const agents = s.local
        ? join(s.cwd, 'AGENTS.md')
        : join(homedir(), '.codex', 'AGENTS.md');

      if (removeBlock(agents)) {
        out.push(`removed instructions from ${agents}`);
      }

      return out;
    },
  },
};

export type { Scope };

export function detectedClients(): string[] {
  return Object.entries(CLIENTS)
    .filter(([, c]) => c.detect())
    .map(([k]) => k);
}
