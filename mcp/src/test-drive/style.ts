/** How the test drive prints: ANSI colours when stdout is a terminal, and an indented block. */

const CODES = {
  dim: '\x1b[2m',
  b: '\x1b[1m',
  cyan: '\x1b[36m',
  mag: '\x1b[35m',
  yel: '\x1b[33m',
  red: '\x1b[31m',
};

const RESET = '\x1b[0m';

const color = process.stdout.isTTY && !process.env.NO_COLOR;

/** `s` in the named colour, or as is without a colour terminal. */
export const paint = (s: string, code: keyof typeof CODES) =>
  color ? CODES[code] + s + RESET : s;

/** Each line of `s`, set off by a dim bar. */
export const indent = (s: string) =>
  s
    .split('\n')
    .map((l) => `   ${paint('│ ', 'dim')}${l}`)
    .join('\n');
