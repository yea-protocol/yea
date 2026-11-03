/**
 * A `yea` command's declaration (its flags, help and run function, side by side so they can't
 * drift) and the parsing of its arguments, which turns a mistake into a `UsageError`.
 */
import { parseArgs } from 'node:util';
import { closest } from '../validate.js';

/** One flag a command takes, and how its help shows it. */
export interface Flag {
  type: 'string' | 'boolean';
  multiple?: boolean;
  short?: string;
  /** The value's placeholder in help, such as `key` for `--to <key>`. */
  value?: string;
  help: string;
}

/** A command's flags, by long name. */
export type Flags = Record<string, Flag>;

type FlagValue<F extends Flag> = F['type'] extends 'boolean'
  ? boolean
  : F['multiple'] extends true
    ? string[]
    : string;

/** The values of the flags `F`, as given on the command line. */
export type Values<F extends Flags> = { [K in keyof F]?: FlagValue<F[K]> };

/** A command: what `yea <name> --help` shows, and what runs. */
export interface Command<F extends Flags = Flags> {
  /** One sentence: what the command does. */
  summary: string;
  /** The synopsis after `yea `, such as `grant [flags]`. */
  usage: string;
  flags: F;
  /** One command line that works as written (or with the obvious placeholder filled in). */
  example: string;
  /**
   * `args` are the positionals after the command's name, `o` its flags, and `argv` the whole
   * command line given to `run`, for a command that runs `yea` again.
   */
  run(args: string[], o: Values<F>, argv: string[]): Promise<void>;
}

/** A mistake on the command line: printed without a stack trace, exiting with status 2. */
export class UsageError extends Error {
  /** A close match for what was mistyped, offered as "did you mean". */
  readonly suggestion?: string;

  constructor(message: string, suggestion?: string) {
    super(message);
    this.name = 'UsageError';
    this.suggestion = suggestion;
  }
}

/** Every command takes `-h, --help`. */
export const HELP_FLAG: Flag = {
  type: 'boolean',
  short: 'h',
  help: 'show this help',
};

/** Declare a command; the flag names in `run`'s `o` are checked against `flags`. */
export function command<F extends Flags>(c: Command<F>): Command<F> {
  return c;
}

/**
 * `args` (what follows the command's name) parsed against `c`'s flags, or a `UsageError` for an
 * unknown flag, a missing value or a value given to a switch.
 */
export function parseCommand(
  c: Command,
  args: string[],
): { args: string[]; values: Values<Flags>; help: boolean } {
  const options = { ...c.flags, help: HELP_FLAG };
  const { values, positionals, tokens } = parseArgs({
    args,
    options,
    allowPositionals: true,
    strict: false,
    tokens: true,
  });

  for (const t of tokens) {
    if (t.kind === 'option') {
      checkOption(options, t);
    }
  }

  const { help, ...flags } = values;

  // Checked above: every option is declared, and has a value exactly when it takes one.
  return { args: positionals, values: flags as Values<Flags>, help: !!help };
}

/** Throw a `UsageError` if the option token `t` doesn't fit `options`. */
function checkOption(
  options: Flags,
  t: { name: string; rawName: string; value?: string; inlineValue?: boolean },
) {
  const flag = Object.hasOwn(options, t.name) ? options[t.name] : undefined;

  if (!flag) {
    // A one-letter flag is too short to say what was meant.
    const near = t.rawName.startsWith('--')
      ? closest(t.name, Object.keys(options))
      : undefined;

    throw new UsageError(`unknown option ${t.rawName}`, near && `--${near}`);
  }

  // `--to --json` is a forgotten value, not the value `--json`; `--to=-x` passes one on purpose.
  const forgotten = !t.inlineValue && t.value?.startsWith('-');

  if (flag.type === 'string' && (t.value === undefined || forgotten)) {
    throw new UsageError(`${t.rawName} needs a value`);
  }

  if (flag.type === 'boolean' && t.value !== undefined) {
    throw new UsageError(`${t.rawName} takes no value`);
  }
}
