/**
 * Grants (SPEC §6): signed, attenuable delegation chains.
 * A principal signs a root block granting a holder key some authority; any holder may
 * append a block delegating a narrower grant to another key.
 * The parts live in grants/: the token, signing, the check, its caveat rules and the periods
 * a `total` with `every` counts in.
 */

export { checkGrant } from './grants/check.js';

export type {
  CheckContext,
  GrantCheck,
  LedgerKey,
  Period,
  TotalLimit,
} from './grants/context.js';

export { delegateGrant, issueGrant } from './grants/issue.js';
export { fmtLimit, usedOf } from './grants/limits.js';
export { anchorOf, endOf, totalKeys } from './grants/periods.js';

export {
  type Block,
  blockId,
  type Caveat,
  decodeGrant,
  encodeGrant,
  type GrantInfo,
  inspectGrant,
  isPublicKey,
} from './grants/token.js';
