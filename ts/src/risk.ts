/** Risk levels (SPEC §5.1), lowest first: one order for grants, policy and approval. */
import type { Risk } from './types.js';

const RISKS: readonly Risk[] = ['low', 'medium', 'high'];

export const isRisk = (v: unknown): v is Risk => RISKS.includes(v as Risk);

/** Whether `r` is `floor` or riskier. */
export const atLeast = (r: Risk, floor: Risk) =>
  RISKS.indexOf(r) >= RISKS.indexOf(floor);
