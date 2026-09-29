/**
 * Lens (SPEC §9): the canonical, compact text a model reads instead of raw JSON.
 * Deterministic: two conforming implementations produce byte-identical output.
 * The parts live in lens/; this file re-exports them.
 */

export { effectsTooDeep, MAX_EFFECT_DEPTH } from './lens/depth.js';

export { est } from './lens/estimate.js';

export { effectLine, fmtDuration, fmtTime } from './lens/format.js';

export { lean, scalar } from './lens/notation.js';

export { lens } from './lens/render.js';

export { oneLine, safeEffectLine, untrustedLens } from './lens/untrusted.js';
