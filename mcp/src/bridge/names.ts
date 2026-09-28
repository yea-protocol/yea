/**
 * Tool names for the bridge (SPEC-bridge, "Tools"): deterministic, and safe for every client and
 * model API, which may accept only `[A-Za-z0-9_-]{1,64}`.
 */
import { sha256 } from '@yea-protocol/sdk';

/** A capability's name is cut here, so `_` and a 6-character suffix still fit in 64. */
const CUT = 57;

/** A service id is cut here for its generic tools, so `_ask` and `_intent` never truncate. */
const SERVICE_CUT = 40;

/** Our own utilities' space (`yea_`, `yea-`, any case): a capability can't take it without a suffix. */
const RESERVED = /^yea[_-]/i;

/** The bridge's own tools, which no remote tool may be named. */
export const UTILITY_TOOLS = ['yea_consent', 'yea_expand', 'yea_undo'];

/** Every character outside `[A-Za-z0-9_-]` becomes `_`, then the name is cut to `max`. */
export const sanitize = (name: string, max = CUT) =>
  name.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, max);

/** The two generic tools' base names for a service past the per-service limit. */
export const genericBase = (service: string, kind: 'ask' | 'intent') =>
  `${sanitize(service, SERVICE_CUT)}_${kind}`;

/** A tool to name: its service, what the suffix hashes, and the name before any suffix. */
export interface ToNames {
  service: string;
  /** The capability name, or `ask`/`intent` for a generic tool. */
  capability: string;
  base: string;
}

/** `_` and the first 6 b64url characters of `sha256(service id + "/" + capability)`. */
async function withSuffix(t: ToNames): Promise<string> {
  const h = await sha256(`${t.service}/${t.capability}`);

  return `${t.base}_${h.slice(0, 6)}`;
}

const countOf = (names: string[]) => {
  const n = new Map<string, number>();

  for (const x of names) {
    n.set(x, (n.get(x) ?? 0) + 1);
  }

  return n;
};

/**
 * The final name of each tool, in order. Names that two tools share, empty ones, and ones in the
 * reserved `yea_` space get the suffix. A name that still clashes after that (with another tool
 * or a utility) is null: that tool isn't served, rather than shadowing another.
 */
export async function assignNames(
  tools: ToNames[],
): Promise<(string | null)[]> {
  const bases = countOf(tools.map((t) => t.base));
  const named = await Promise.all(
    tools.map((t) =>
      (bases.get(t.base) ?? 0) > 1 || !t.base || RESERVED.test(t.base)
        ? withSuffix(t)
        : t.base,
    ),
  );
  const finals = countOf([...named, ...UTILITY_TOOLS]);

  return named.map((n) => ((finals.get(n) ?? 0) > 1 ? null : n));
}
