/**
 * The demo's narrator: numbered steps, the frames on the wire, and each reply exactly as a model
 * reads it, with its token count. Also `day`, the dates the scenes ask for.
 */
import { est } from '../../index.js';

export const ANSI = {
  dim: '\x1b[2m',
  b: '\x1b[1m',
  cyan: '\x1b[36m',
  mag: '\x1b[35m',
  yel: '\x1b[33m',
  grn: '\x1b[32m',
  red: '\x1b[31m',
  x: '\x1b[0m',
};

export const day = (n: number) =>
  new Date(Date.now() + n * 86400e3).toISOString().slice(0, 10);

export function narrator() {
  const color =
    (process.stdout.isTTY || !!process.env.FORCE_COLOR) &&
    !process.env.NO_COLOR;
  const k = (s: string, code: string) => (color ? code + s + ANSI.x : s);
  let step = 0;

  return {
    k,
    human: k('👤 human', ANSI.yel),
    agent: k('🤖 agent', ANSI.mag),
    sub: k('🤖 sub-agent', ANSI.mag),
    say(who: string, text: string) {
      step += 1;
      console.log(`\n${k(`${step}.`, ANSI.dim)} ${k(who, ANSI.b)} ${text}`);
    },
    wire(verb: string, detail: string) {
      console.log(k(`   → ${verb}`, ANSI.cyan) + k(` ${detail}`, ANSI.dim));
    },
    show(text: string) {
      console.log(
        text
          .split('\n')
          .map((l) => `   ${k('│ ', ANSI.dim)}${l}`)
          .join('\n'),
      );
      console.log(k(`   └ ${est(text)} tokens`, ANSI.dim));
    },
  };
}

export type Narrator = ReturnType<typeof narrator>;
