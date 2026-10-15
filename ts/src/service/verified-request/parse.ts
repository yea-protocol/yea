/**
 * Reading a request frame (SPEC §2.1, §3, §4): the envelope, the verb and the fields that verb
 * reads, from the frame alone. Covered by `conformance/requests.json`.
 */
import { hasLoneSurrogate } from '../../canonical.js';
import { fix, YeaError } from '../../errors.js';
import type { Proof } from '../../types.js';
import { isObject, positiveInt } from '../../util.js';

interface Base {
  id: string;
  /** The frame's `budget`, or null when it is missing or not a whole number above 0. */
  budget: number | null;
}

/** What every verb but HELLO and EXPAND carries: its grants, and a well-formed proof or null. */
interface Signed {
  grants: string[];
  proof: Proof | null;
}

/**
 * A request frame, read: its fields for its verb, nothing verified yet. A name the verb looks up
 * (`capability`, `proposal`, `hash`, `receipt`, `handle`) is null when it is missing or not a
 * string, so the lookup fails as it would for an unknown name.
 */
export type ParsedRequest =
  | (Base & { verb: 'HELLO' })
  | (Base &
      Signed & {
        verb: 'ASK';
        capability: string | null;
        params: Record<string, unknown>;
      })
  | (Base &
      Signed & {
        verb: 'INTENT';
        capability: string | null;
        params: Record<string, unknown>;
        goal: string | null;
        auto: boolean;
      })
  | (Base &
      Signed & { verb: 'COMMIT'; proposal: string | null; hash: string | null })
  | (Base & Signed & { verb: 'UNDO'; receipt: string | null })
  | (Base & { verb: 'EXPAND'; handle: string | null; proof: Proof | null });

const VERBS = ['HELLO', 'ASK', 'INTENT', 'COMMIT', 'UNDO', 'EXPAND'];

/**
 * Read a request frame; throws `bad_frame` or `invalid_params` when the frame alone is wrong. A
 * malformed `grants` is a `bad_frame` even when `params` is wrong too.
 */
export function parseRequest(frame: unknown): ParsedRequest {
  const f = envelope(frame);
  const base: Base = { id: f.id, budget: positiveInt(f.budget) ?? null };

  switch (f.verb) {
    case 'HELLO':
      return { verb: 'HELLO', ...base };
    case 'ASK': {
      const s = signed(f);

      return { verb: 'ASK', ...base, ...capabilityCall(f), ...s };
    }
    case 'INTENT': {
      const s = signed(f);

      return {
        verb: 'INTENT',
        ...base,
        ...capabilityCall(f),
        goal: typeof f.goal === 'string' ? f.goal : null,
        auto: f.auto === true,
        ...s,
      };
    }
    case 'COMMIT':
      return {
        verb: 'COMMIT',
        ...base,
        proposal: name(f.proposal),
        hash: name(f.hash),
        ...signed(f),
      };
    case 'UNDO':
      return { verb: 'UNDO', ...base, receipt: name(f.receipt), ...signed(f) };
    case 'EXPAND':
      return {
        verb: 'EXPAND',
        ...base,
        handle: name(f.handle),
        proof: proofOf(f.proof),
      };
    default:
      throw unknownVerb(f.verb);
  }
}

/** The envelope every request needs (SPEC §2.1), with no lone surrogate anywhere (SPEC §10). */
function envelope(frame: unknown): Record<string, unknown> & { id: string } {
  if (!isObject(frame) || frame.yea !== 1 || typeof frame.id !== 'string') {
    throw new YeaError('bad_frame', 'frames need "yea": 1 and a string "id"');
  }

  // A lone surrogate has no canonical form: refuse the frame here, before a handler hashes it
  // and fails as `internal`.
  if (hasLoneSurrogate(frame)) {
    throw new YeaError('bad_frame', 'a string holds a lone surrogate');
  }

  return { ...frame, id: frame.id };
}

function unknownVerb(verb: unknown): YeaError {
  return new YeaError(
    'bad_frame',
    `unknown verb ${JSON.stringify(verb ?? null)}`,
    { fix: [fix(`use one of ${VERBS.join(', ')}`)] },
  );
}

const name = (v: unknown): string | null => (typeof v === 'string' ? v : null);

const capabilityCall = (f: Record<string, unknown>) => ({
  capability: name(f.capability),
  params: paramsOf(f.params),
});

const signed = (f: Record<string, unknown>): Signed => ({
  grants: grantsOf(f.grants),
  proof: proofOf(f.proof),
});

/** A request's params: `{}` when absent or null, and otherwise an object (SPEC §4.2, §4.3). */
function paramsOf(params: unknown): Record<string, unknown> {
  if (params === undefined || params === null) {
    return {};
  }

  if (!isObject(params)) {
    throw new YeaError('invalid_params', '`params` must be an object');
  }

  return params;
}

const badGrants = () =>
  new YeaError('bad_frame', '`grants` must be a list of strings');

/**
 * A request's grants (SPEC §3). Only a missing, null or empty `grants` is no grants; anything
 * else must be a list of strings. The loop reads every index, so a hole in a sparse array (which
 * `every` would skip) is refused too.
 */
function grantsOf(grants: unknown): string[] {
  if (grants === undefined || grants === null) {
    return [];
  }

  if (!Array.isArray(grants)) {
    throw badGrants();
  }

  const out: string[] = [];

  for (let i = 0; i < grants.length; i++) {
    const g: unknown = grants[i];

    if (typeof g !== 'string') {
      throw badGrants();
    }

    out.push(g);
  }

  return out;
}

/**
 * A proof of the shape SPEC §6.5 gives it, or null. Only its shape is read here; a malformed one
 * fails as a missing proof when a grant needs it.
 */
function proofOf(proof: unknown): Proof | null {
  if (
    isObject(proof) &&
    typeof proof.key === 'string' &&
    typeof proof.sig === 'string' &&
    Number.isSafeInteger(proof.ts)
  ) {
    return { key: proof.key, ts: Number(proof.ts), sig: proof.sig };
  }

  return null;
}
