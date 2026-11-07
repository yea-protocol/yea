/**
 * The playground's Undo button (#83): it is offered exactly when the SDK's undo-window rule says
 * the receipt has a window (`until` minus `at`), so never for a window of zero or less, nor for an
 * undo receipt. It imports the TypeScript source and the built SDK, so it needs Node's type
 * stripping (22.18+) and `npm run build` first.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';

const built = existsSync(new URL('../../ts/dist/index.js', import.meta.url));
const skip =
  (!process.features.typescript &&
    'needs Node with type stripping (22.18+) to import .ts') ||
  (!built && 'needs npm run build');

/** A RECEIPT reply committed at 100, with this `undo`. */
const receipt = (undo, extra = {}) => ({
  yea: 1,
  id: 's_1',
  re: 'f_1',
  kind: 'RECEIPT',
  receipt: {
    id: 'r_1',
    proposal: 'p_1',
    capability: 'cal.move',
    summary: 'Moved',
    at: 100,
    effects: [],
    undo,
    ...extra,
  },
});

test('Undo is offered only for a receipt with an undo window', {
  skip,
}, async () => {
  const sdk = await import('../../ts/dist/index.js');
  const { undoOffer } = await import(
    '../.vitepress/theme/components/playground/seen.ts'
  );

  assert.equal(undoOffer(sdk, receipt({ until: 160 })), 'r_1');

  for (const undo of [
    null,
    { until: 100 },
    { until: 40 },
    { until: 'later' },
  ]) {
    assert.equal(undoOffer(sdk, receipt(undo)), null, JSON.stringify(undo));
  }

  assert.equal(
    undoOffer(sdk, receipt({ until: 160 }, { undoes: 'r_0' })),
    null,
  );
  assert.equal(
    undoOffer(sdk, { yea: 1, id: 's', re: 'f', kind: 'ANSWER' }),
    null,
  );
});
