/**
 * Reproduces the token-estimator comparison in docs/design.md: how well each candidate
 * `est()` tracks a real BPE tokenizer (o200k) on the text YEA actually sends.
 */

import { readFileSync } from 'node:fs';
import { Client, est, lean, local } from '@yea-protocol/sdk';
import { encode } from 'gpt-tokenizer/encoding/o200k_base';
import { catalog, shop } from '../examples/shop.ts';

const lensCases: { lens: string }[] = JSON.parse(
  readFileSync(new URL('../conformance/lens.json', import.meta.url), 'utf8'),
);
const results = readFileSync(new URL('./RESULTS.md', import.meta.url), 'utf8');
const corpus = [
  ...lensCases.map((c) => c.lens),
  ...results.split('```').filter((_, i) => i % 2 === 1),
  JSON.stringify(catalog),
  JSON.stringify(catalog, null, 2),
  lean({ items: catalog }),
].filter((t) => encode(t).length >= 15);

const candidates: Record<string, (s: string) => number> = {
  'ceil(bytes / 4)': (s) => Math.ceil(Buffer.byteLength(s) / 4),
  'ceil(bytes / 3)': (s) => Math.ceil(Buffer.byteLength(s) / 3),
  'YEA est() (SPEC §8 regex)': est,
};

console.log(
  `corpus: ${corpus.length} texts (conformance Lens outputs, benchmark payloads, the menu as JSON/Lens), each ≥ 15 real tokens\n`,
);
console.log(
  '| Estimator | mean ratio to o200k | min | max |\n|---|---|---|---|',
);

for (const [name, f] of Object.entries(candidates)) {
  const r = corpus.map((t) => f(t) / encode(t).length);

  console.log(
    `| ${name} | ${(r.reduce((a, b) => a + b) / r.length).toFixed(2)} | ${Math.min(...r).toFixed(2)} | ${Math.max(...r).toFixed(2)} |`,
  );
}

// What bytes/4 did to budgets: the full menu "fits" an 800-token budget by that measure.
const svc = new Client(local(shop({ trust: [] })));
const full = await svc.ask('shop.search', {}, { budget: 1e6 });

console.log(
  `\nfull 60-item menu as Lens: ${encode(full.lens).length} real tokens · bytes/4 says ${Math.ceil(Buffer.byteLength(full.lens) / 4)} (so a bytes/4 budget of 800 lets it all through) · est() says ${est(full.lens)}`,
);
