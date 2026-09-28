/**
 * Turns `FORCE_COLOR=1 node examples/demo.ts > demo.ansi` into an asciinema cast, then:
 *   node scripts/demo-cast.cjs demo.ansi demo.cast && npx svg-term-cli --in demo.cast --out docs/demo.svg --window --no-cursor --padding 18
 */
const fs = require('node:fs');
const { stripVTControlCharacters } = require('node:util');
const text = fs.readFileSync(process.argv[2], 'utf8');
const lines = text.split('\n');
const events = [];
let t = 0.3;

for (const raw of lines) {
  const plain = stripVTControlCharacters(raw);

  if (/^\d+\. /.test(plain)) {
    t += 1.6; // new step: pause so the viewer can read
  } else if (plain.trim().startsWith('→')) {
    t += 0.5;
  } else if (plain.includes('└')) {
    t += 0.25;
  } else {
    t += 0.045;
  }

  events.push([Number(t.toFixed(3)), 'o', `${raw}\r\n`]);
}

events.push([t + 4, 'o', '']);

const header = {
  version: 2,
  width: 118,
  height: 34,
  env: { TERM: 'xterm-256color' },
};

fs.writeFileSync(
  process.argv[3],
  [JSON.stringify(header), ...events.map((e) => JSON.stringify(e))].join('\n') +
    '\n',
);
console.log('duration', t.toFixed(1), 's,', lines.length, 'lines');
