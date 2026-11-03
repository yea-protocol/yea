/** What `yea <command> --help` prints, and how a `UsageError` reads, built from a `Command`. */
import {
  type Command,
  type Flag,
  HELP_FLAG,
  type UsageError,
} from './command.js';

/** A command's help: what it does, its synopsis, every flag it takes and one example. */
export function commandHelp(c: Command): string {
  const flags = Object.entries({ ...c.flags, help: HELP_FLAG }).map(
    ([name, f]) => [flagName(name, f), flagHelp(f)],
  );
  const width = Math.max(...flags.map(([name]) => name.length));

  return [
    c.summary,
    '',
    `usage: yea ${c.usage}`,
    '',
    'flags',
    ...flags.map(([name, help]) => `  ${name.padEnd(width)}  ${help}`),
    '',
    'example',
    `  ${c.example}`,
  ].join('\n');
}

/** `-y, --yes` or `    --to <key>`: short names line up in their own column. */
function flagName(name: string, f: Flag): string {
  const short = f.short ? `-${f.short}, ` : '    ';
  const value = f.type === 'string' ? ` <${f.value ?? 'value'}>` : '';

  return `${short}--${name}${value}`;
}

const flagHelp = (f: Flag) => (f.multiple ? `${f.help} (repeatable)` : f.help);

/**
 * A usage error as printed: the mistake (and the command it was made in), a hint such as "did
 * you mean" when there is one, and where to look next.
 */
export function usageMessage(e: UsageError, name?: string): string {
  return [
    `yea: ${e.message}${name ? ` for '${name}'` : ''}`,
    ...(e.hint ? [e.hint] : []),
    name
      ? `run 'yea ${name} --help' for usage`
      : "run 'yea help' for the list of commands",
  ].join('\n');
}
