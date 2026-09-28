/**
 * Type-check the docs site's theme (its .ts and .vue files) with vue-tsc. vue-tsc drives the
 * JavaScript compiler API, which TypeScript 7 no longer ships, so it runs on TypeScript 6
 * (installed as `typescript6`). Arguments pass through: `--noEmit -p site`.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

require('vue-tsc').run(require.resolve('typescript6/lib/tsc'));
