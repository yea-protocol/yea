/**
 * Estimating the tokens in Lens text (SPEC §8), the same way in every implementation.
 */

/**
 * Shared token estimate (SPEC §8): count of letter runs, 1–3 digit groups, indentation runs
 * and other non-space characters. Tracks real BPE tokenizers closely on Lens text (mean
 * ratio ≈1.0 vs o200k), and every implementation computes exactly the same number.
 */
const TOKENISH = /[A-Za-z]+|[0-9]{1,3}|\n {2,}|[^ \t\n\r\f\vA-Za-z0-9]/gu;

export const est = (text: string) => text.match(TOKENISH)?.length ?? 0;
