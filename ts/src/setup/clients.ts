/** The AI tools `yea install` knows: where each keeps its MCP servers and agent instructions. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { removeBlock, writeBlock } from './instructions.js';
import { has, jsonTarget, type Target } from './target.js';

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
