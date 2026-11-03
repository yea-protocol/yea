/**
 * The bridge's entry in Codex CLI's config.toml, the `[mcp_servers.yea]` table: written, read
 * back and removed line by line, leaving the rest of the file as it was. Values are written as
 * JSON strings and arrays, which TOML reads the same way; anything else can't be read back.
 */
import { type BridgeCommand, parseBridge } from './bridge-command.js';

const HEADER = '[mcp_servers.yea]';

/** A TOML table header line. */
const TABLE = /^\s*\[/;

/** The lines of `text`'s yea table, header first, and where it starts and ends; null if none. */
function findTable(lines: string[]): { start: number; end: number } | null {
  const start = lines.findIndex((l) => l.trim() === HEADER);

  if (start < 0) {
    return null;
  }

  let end = start + 1;

  while (end < lines.length && !TABLE.test(lines[end])) {
    end++;
  }

  return { start, end };
}

/** `text` without the yea table: its header line and every line up to the next table header. */
export function dropTable(text: string): string {
  const lines = text.split('\n');
  const at = findTable(lines);

  if (!at) {
    return text;
  }

  return [...lines.slice(0, at.start), ...lines.slice(at.end)]
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

/** `text` with the yea table set to `b`, appended at the end. */
export function writeTable(text: string, b: BridgeCommand): string {
  const rest = dropTable(text).replace(/\n*$/, '');
  const env = b.env
    ? [
        `env = { ${Object.entries(b.env)
          .map(([k, v]) => `${JSON.stringify(k)} = ${JSON.stringify(v)}`)
          .join(', ')} }`,
      ]
    : [];
  const table = [
    HEADER,
    `command = ${JSON.stringify(b.command)}`,
    `args = ${JSON.stringify(b.args)}`,
    ...env,
  ];

  return `${rest ? `${rest}\n\n` : ''}${table.join('\n')}\n`;
}

/** The bridge command in `text`'s yea table, or null if it has none; throws if it can't be read. */
export function readTable(text: string): BridgeCommand | null {
  const lines = text.split('\n');
  const at = findTable(lines);

  if (!at) {
    return null;
  }

  const entry: Record<string, unknown> = {};

  for (const line of lines.slice(at.start + 1, at.end)) {
    const m = /^\s*(command|args|env)\s*=\s*(.+?)\s*$/.exec(line);

    if (m) {
      entry[m[1]] = parseValue(m[1], m[2]);
    }
  }

  return parseBridge(entry);
}

/** One value as `writeTable` writes it; throws for any other TOML. */
function parseValue(key: string, value: string): unknown {
  // An inline table of strings, `{ "K" = "v", … }`, is a JSON object once `=` is `:`.
  const json =
    key === 'env' ? value.replace(/("(?:[^"\\]|\\.)*")\s*=/g, '$1:') : value;

  try {
    return JSON.parse(json);
  } catch {
    throw new Error(`can't read its ${key}: ${value}`);
  }
}
