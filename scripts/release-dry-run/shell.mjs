/**
 * Running the dry run's commands: each one's output is captured, and a failure
 * throws with the command and what it printed, so a step reports why it failed.
 */
import { execFileSync } from 'node:child_process';

/** The cap on what one command may print: npm and uv are chatty. */
const MAX_OUTPUT = 64 * 1024 * 1024;

/**
 * Runs `command` with `args` and returns its stdout; throws when it exits
 * non-zero, quoting its output.
 */
export function sh(command, args, options = {}) {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      maxBuffer: MAX_OUTPUT,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    });
  } catch (error) {
    const output = `${error.stdout ?? ''}${error.stderr ?? ''}`.trim();

    throw new Error(
      `${[command, ...args].join(' ')} failed\n${output || error.message}`,
    );
  }
}

/**
 * The line that says why a command `sh` ran failed: the first naming an
 * error, else the first it printed, else the command itself.
 */
export function errorLine(error) {
  const [command, ...output] = error.message.split('\n');

  return output.find((line) => /Error\b/.test(line)) ?? output[0] ?? command;
}
