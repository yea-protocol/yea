/** The AI tools `yea install` knows: where each keeps its MCP servers and agent instructions. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { dropTable, readTable, writeTable } from './codex-config.js';
import { removeBlock, writeBlock } from './instructions.js';
import { has, jsonTarget, type Scope, type Target } from './target.js';

const devinDir = () =>
  join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'devin');
const appData = () =>
  process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
const codexConfig = () => join(homedir(), '.codex', 'config.toml');
const readText = (file: string) =>
  existsSync(file) ? readFileSync(file, 'utf8') : '';
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

/** Where Codex reads agent instructions: the project's AGENTS.md with --local, else its own. */
const codexAgents = (s: Scope) =>
  s.local ? join(s.cwd, 'AGENTS.md') : join(homedir(), '.codex', 'AGENTS.md');

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
    project: () => false,
    gui: true,
  }),
  cursor: jsonTarget({
    name: 'Cursor',
    file: (s) =>
      s.local
        ? join(s.cwd, '.cursor', 'mcp.json')
        : join(homedir(), '.cursor', 'mcp.json'),
    detect: () => existsSync(join(homedir(), '.cursor')),
    block: (s) => (s.local ? join(s.cwd, '.cursor', 'rules', 'yea.mdc') : ''),
    gui: true,
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
    project: () => false,
    gui: true,
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
  // Its config is always the project's .vscode/mcp.json.
  vscode: jsonTarget({
    name: 'VS Code',
    file: (s) => join(s.cwd, '.vscode', 'mcp.json'),
    detect: () => has('code'),
    project: () => true,
    gui: true,
    key: 'servers',
    extra: { type: 'stdio' },
  }),
  // Its config is always ~/.codex/config.toml; --local only moves the instructions.
  codex: {
    name: 'Codex CLI',
    gui: false,
    detect: () => existsSync(join(homedir(), '.codex')),
    project: () => false,
    registered: () => readTable(readText(codexConfig())),
    install: (s, bridge) => {
      const file = codexConfig();

      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, writeTable(readText(file), bridge));

      return [
        `MCP server "yea" → ${file}`,
        `agent instructions → ${writeBlock(codexAgents(s))}`,
      ];
    },
    uninstall: (s) => {
      const file = codexConfig();
      const cur = readText(file);
      const next = dropTable(cur);
      const out: string[] = [];

      if (next !== cur) {
        writeFileSync(file, next);
        out.push(`removed [mcp_servers.yea] from ${file}`);
      }

      if (removeBlock(codexAgents(s))) {
        out.push(`removed instructions from ${codexAgents(s)}`);
      }

      return out;
    },
  },
};
