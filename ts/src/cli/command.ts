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
  /** The values it takes, if a few: a bare argument that is one is offered as this flag's. */
  choices?: readonly string[];
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
  /**
   * The synopsis after `yea `, such as `grant [flags]`. It also says how many arguments the
   * command takes: each `<x>` or `[<x>]` is one, and `…` means any number (see `maxArgs`).
   */
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
  /** One line on what to do instead, such as "did you mean --to?". */
  readonly hint?: string;

  constructor(message: string, hint?: string) {
    super(message);
    this.name = 'UsageError';
    this.hint = hint;
  }
}

/** The positional argument at `i`, or a `UsageError` saying `<what>` is missing. */
export function positional(args: string[], i: number, what: string): string {
  const arg = args[i];

  if (arg === undefined) {
    throw new UsageError(`missing <${what}>`);
  }

  return arg;
}

/** "did you mean `near`?", when there is something near. */
export const didYouMean = (near: string | undefined) =>
  near && `did you mean ${near}?`;

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
 * How many arguments `usage` shows: each `<x>` or `[<x>]` is one and `…` means any number. A
 * flag's value (`--to <key>`) and `[flags]` don't count.
 */
export function maxArgs(usage: string): number {
  const words = usage.split(' ').slice(1);

  if (words.some((w) => w.includes('…'))) {
    return Infinity;
  }

  return words.filter(
    (w, i) =>
      w !== '[flags]' && !w.startsWith('--') && !words[i - 1]?.startsWith('--'),
  ).length;
}

/**
 * `args` (what follows the command's name) parsed against `c`'s flags, or a `UsageError` for an
 * unknown flag, a missing value, a value given to a switch, or an argument it doesn't take.
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

  if (!help) {
    checkArgs(c, tokens);
  }

  // Checked above: every option is declared, and has a value exactly when it takes one.
  return { args: positionals, values: flags as Values<Flags>, help: !!help };
}

/** One argument (or a flag and its value), as `parseArgs` reads it. */
type Token = NonNullable<ReturnType<typeof parseArgs>['tokens']>[number];

/**
 * Throw a `UsageError` for the first argument past what `c`'s usage shows, which would
 * otherwise be dropped (`yea grant --svc a b` would grant `a` only).
 */
function checkArgs(c: Command, tokens: Token[]) {
  const max = maxArgs(c.usage);
  const extra = tokens.filter((t) => t.kind === 'positional')[max];

  if (extra?.kind !== 'positional') {
    return;
  }

  const before = tokens[tokens.indexOf(extra) - 1];

  throw new UsageError(
    `unexpected argument ${extra.value}`,
    asFlagValue(c.flags, extra.value) ??
      (before?.kind === 'option' && before.value !== undefined
        ? oneValueHint(c.flags, before.name)
        : undefined),
  );
}

/** "did you mean --target cursor?", when `arg` is among a flag's choices. */
function asFlagValue(flags: Flags, arg: string): string | undefined {
  const parts = arg.split(',');
  const name = Object.keys(flags).find((n) =>
    parts.every((p) => flags[n].choices?.includes(p)),
  );

  return name && didYouMean(`--${name} ${arg}`);
}

/** What to do when an argument follows the value of the flag `name`. */
function oneValueHint(flags: Flags, name: string): string | undefined {
  const flag = Object.hasOwn(flags, name) ? flags[name] : undefined;

  if (!flag) {
    return undefined;
  }

  return flag.multiple
    ? `--${name} takes one value; repeat it for each: --${name} <a> --${name} <b>`
    : `--${name} takes one value: <${flag.value ?? 'value'}>`;
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

    throw new UsageError(
      `unknown option ${t.rawName}`,
      didYouMean(near && `--${near}`),
    );
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
