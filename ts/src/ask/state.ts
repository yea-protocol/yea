/**
 * The approval state that goes round the client (docs/framework/SPEC-approval.md
 * §4): making it, and checking the one that comes back.
 */
import { canonical } from '../canonical.js';
import { randomId, sha256 } from '../crypto.js';
import { isStringList } from '../util.js';

export interface ApprovalState {
  v: 1;
  tool: string;
  inputHash: string;
  sub: string;
  plans: string[];
  round: number;
  nonce: string;
  exp: number;
}

export const MAX_ROUNDS = 3;
export const STATE_TTL = 600;

export const inputHashOf = (input: unknown) => sha256(canonical(input));

export function newState(o: {
  tool: string;
  inputHash: string;
  sub: string;
  plans: string[];
  round: number;
  now: number;
  ttl?: number;
}): ApprovalState {
  return {
    v: 1,
    tool: o.tool,
    inputHash: o.inputHash,
    sub: o.sub,
    plans: o.plans,
    round: o.round,
    nonce: randomId('n', 12),
    exp: o.now + (o.ttl ?? STATE_TTL),
  };
}

/** A round counts the forms shown, from 1; one past the last is never sent round (§4). */
const isRound = (r: unknown): r is number =>
  Number.isSafeInteger(r) && (r as number) >= 1 && (r as number) <= MAX_ROUNDS;

function isState(v: unknown): v is ApprovalState {
  const s = v as Partial<ApprovalState> | null;

  return (
    !!s &&
    s.v === 1 &&
    typeof s.tool === 'string' &&
    typeof s.inputHash === 'string' &&
    typeof s.sub === 'string' &&
    isStringList(s.plans) &&
    isRound(s.round) &&
    typeof s.nonce === 'string' &&
    Number.isSafeInteger(s.exp)
  );
}

/** Why a returned state can't be used for this call; one message for every reason (§5 step 1). */
export function checkState(
  v: unknown,
  expect: { tool: string; inputHash: string; sub: string; now: number },
): ApprovalState | null {
  if (
    !isState(v) ||
    v.tool !== expect.tool ||
    v.inputHash !== expect.inputHash ||
    v.sub !== expect.sub ||
    expect.now >= v.exp
  ) {
    return null;
  }

  return v;
}
