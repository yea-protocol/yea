/**
 * Grants (SPEC §6): signed, attenuable delegation chains.
 * A principal signs a root block granting a holder key some authority; any holder may
 * append a block delegating a narrower grant to another key.
 * The parts live in grants/: the token, signing, the check and its caveat rules.
 */

export { checkGrant } from './grants/check.js';
export type { CheckContext, GrantCheck, TotalLimit } from './grants/context.js';
export { delegateGrant, issueGrant } from './grants/issue.js';
export { usedOf } from './grants/limits.js';

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
