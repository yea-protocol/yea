/**
 * The bridge's entry in Codex CLI's config.toml, the `[mcp_servers.yea]` table: written, read
 * back and removed line by line, leaving the rest of the file as it was. Its header is found
 * however TOML lets it be written (spaced, quoted or commented). Removing it also removes its
 * sub-tables, such as `[mcp_servers.yea.env]`, so a new entry doesn't keep an old one's parts.
 * Values are written as JSON strings and arrays, which TOML reads the same way; anything else
 * can't be read back.
 */
import { BadEntry, type BridgeCommand, parseBridge } from './bridge-command.js';

const HEADER = '[mcp_servers.yea]';

/** A key in a header or a dotted key: bare, or in either kind of quotes. */
const key = (k: string) => `(?:${k}|"${k}"|'${k}')`;

/** `mcp_servers.yea`, however it's spaced or quoted. */
const YEA = `${key('mcp_servers')}\\s*\\.\\s*${key('yea')}`;

/** The yea table's header. */
const YEA_TABLE = new RegExp(`^\\s*\\[\\s*${YEA}\\s*\\]\\s*(?:#.*)?$`);

/** A header of one of its sub-tables (or arrays of them), such as `[mcp_servers.yea.env]`. */
const YEA_SUB_TABLE = new RegExp(`^\\s*\\[\\[?\\s*${YEA}\\s*\\.`);

/** Any header naming the yea server: those two, or an array of tables, `[[mcp_servers.yea]]`. */
const YEA_ANY_HEADER = new RegExp(`^\\s*\\[\\[?\\s*${YEA}\\s*[\\].]`);

/** The `[mcp_servers]` table's header, under which a `yea` key is the same server. */
const SERVERS_TABLE = new RegExp(
  `^\\s*\\[\\s*${key('mcp_servers')}\\s*\\]\\s*(?:#.*)?$`,
);

/** `yea = …` or `yea.command = …`, as a key of `[mcp_servers]`. */
const YEA_KEY = new RegExp(`^\\s*${key('yea')}\\s*[.=]`);

/** `mcp_servers.yea… = …`, as a dotted key before any table. */
const YEA_DOTTED_KEY = new RegExp(`^\\s*${YEA}\\s*[.=]`);

/** Any table header: `[a.b]` or `[[a.b]]`, its keys bare or quoted, then maybe a comment. */
const TABLE =
  /^\s*\[\[?\s*(?:[\w-]+|"[^"]*"|'[^']*')(?:\s*\.\s*(?:[\w-]+|"[^"]*"|'[^']*'))*\s*\]\]?\s*(?:#.*)?$/;

/** Whether `line` heads the yea table or one of its sub-tables: what `dropTable` removes. */
const isYeaHeader = (line: string) =>
  YEA_TABLE.test(line) || YEA_SUB_TABLE.test(line);

/** Where the yea table's own lines are: its header, up to the next header; null if none. */
function findTable(lines: string[]): { start: number; end: number } | null {
  const start = lines.findIndex((l) => YEA_TABLE.test(l));

  if (start < 0) {
    return null;
  }

  let end = start + 1;

  while (end < lines.length && !TABLE.test(lines[end])) {
    end++;
  }

  return { start, end };
}

/** `text` without the yea table and its sub-tables: each header and its lines, to the next header. */
export function dropTable(text: string): string {
  let dropping = false;
  const kept = text.split('\n').filter((line) => {
    if (TABLE.test(line)) {
      dropping = isYeaHeader(line);
    }

    return !dropping;
  });

  return kept.join('\n').replace(/\n{3,}/g, '\n\n');
}

/**
 * The line of `rest` (a config without the yea table) that still defines the yea server: a
 * header naming it, a `yea` key in `[mcp_servers]`, or a dotted key before any table.
 */
function otherDefinition(rest: string): string | undefined {
  let table: string | null = null;

  return rest.split('\n').find((line) => {
    if (TABLE.test(line)) {
      table = line;

      return YEA_ANY_HEADER.test(line);
    }

    if (table === null) {
      return YEA_DOTTED_KEY.test(line);
    }

    return SERVERS_TABLE.test(table) && YEA_KEY.test(line);
  });
}

/** Why yea can't replace the entry in `text`: it defines the server some other way too. */
function unreplaceable(text: string): Error | null {
  const line = otherDefinition(dropTable(text));

  return line === undefined
    ? null
    : new Error(
        `its config defines mcp_servers.yea in a way yea can't replace (${line.trim()}): remove that, or edit the entry by hand`,
      );
}

/** `text` with the yea table set to `b`, appended at the end; throws rather than define it twice. */
export function writeTable(text: string, b: BridgeCommand): string {
  const conflict = unreplaceable(text);

  if (conflict) {
    throw conflict;
  }

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

/**
 * The bridge command in `text`'s yea table, or null if it has none. Throws a BadEntry if the
 * entry can't be read, and an Error if it's defined in a way install can't replace.
 */
export function readTable(text: string): BridgeCommand | null {
  const conflict = unreplaceable(text);

  if (conflict) {
    throw conflict;
  }

  const lines = text.split('\n');
  const at = findTable(lines);

  if (!at) {
    // Sub-tables alone, such as `[mcp_servers.yea.env]`, make an entry with no command.
    if (lines.some(isYeaHeader)) {
      throw new BadEntry('it has no command');
    }

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

/** One value as `writeTable` writes it; throws a BadEntry for any other TOML. */
function parseValue(key: string, value: string): unknown {
  // An inline table of strings, `{ "K" = "v", … }`, is a JSON object once `=` is `:`.
  const json =
    key === 'env' ? value.replace(/("(?:[^"\\]|\\.)*")\s*=/g, '$1:') : value;

  try {
    return JSON.parse(json);
  } catch {
    throw new BadEntry(`can't read its ${key}: ${value}`);
  }
}
