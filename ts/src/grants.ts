/**
 * Grants (SPEC §6): signed, attenuable delegation chains.
 * A principal signs a root block granting a holder key some authority; any holder may
 * append a block delegating a narrower grant to another key.
 */
import { b64u, fromUtf8, unb64u, utf8 } from './b64.js';
import { canonical } from './canonical.js';
import { type KeyPair, keyPair, sha256, sign, verify } from './crypto.js';
import { atLeast, isRisk } from './risk.js';
import type { ConsentRequest, Proof, Proposal, Risk, Verb } from './types.js';
import {
  exact,
  fmtQuantity,
  isLimit,
  isUses,
  type Limit,
  limitQuantity,
  sameUnit,
  type Uses,
} from './uses.js';
import { unixNow } from './util.js';

export type Caveat =
  | { svc: string[] }
  | { verbs: Verb[] }
  | { can: string[] }
  | { exp: number }
  | { nbf: number }
  | { each: Limit }
  | { total: Limit }
  | { risk: Risk }
  | { only: string };

export interface Block {
  p: Record<string, unknown> & { sub: string; caveats: Caveat[]; iat: number };
  s: string;
}

const PREFIX = 'pg1.';

export function encodeGrant(blocks: Block[]): string {
  return PREFIX + b64u(utf8(canonical(blocks)));
}

export function decodeGrant(token: string): Block[] {
  if (!token.startsWith(PREFIX)) {
    throw new Error('not a pg1 grant');
  }

  // Language-neutral: every implementation reports the same text (SPEC-approval reasons).
  let blocks: unknown;

  try {
    blocks = JSON.parse(fromUtf8(unb64u(token.slice(PREFIX.length))));
  } catch {
    throw new Error('not valid b64url JSON');
  }

  if (!Array.isArray(blocks) || blocks.length === 0) {
    throw new Error('grant has no blocks');
  }

  for (const b of blocks as Partial<Block>[]) {
    if (
      typeof b?.s !== 'string' ||
      typeof b?.p?.sub !== 'string' ||
      !Array.isArray(b?.p?.caveats)
    ) {
      throw new Error('malformed block');
    }
  }

  return blocks as Block[];
}

export const blockId = (b: Block) => sha256(b.s);

/** Issue a root grant from `principal` to the key `to`. */
export async function issueGrant(opts: {
  principal: KeyPair | string;
  to: string;
  caveats?: Caveat[];
  iat?: number;
  nonce?: string;
}): Promise<string> {
  const principal =
    typeof opts.principal === 'string'
      ? await keyPair(opts.principal)
      : opts.principal;
  const p = {
    iss: principal.public,
    sub: opts.to,
    caveats: opts.caveats ?? [],
    iat: opts.iat ?? unixNow(),
    nonce:
      opts.nonce ?? b64u(globalThis.crypto.getRandomValues(new Uint8Array(12))),
  };

  return encodeGrant([{ p, s: await sign(principal.seed, canonical(p)) }]);
}

/** Attenuate: the current holder (by seed) delegates a narrower grant to `to`. */
export async function delegateGrant(
  token: string,
  opts: {
    holder: KeyPair | string;
    to: string;
    caveats?: Caveat[];
    iat?: number;
  },
): Promise<string> {
  const blocks = decodeGrant(token);
  const holder =
    typeof opts.holder === 'string' ? await keyPair(opts.holder) : opts.holder;
  const last = blocks[blocks.length - 1];

  if (last.p.sub !== holder.public) {
    throw new Error('only the current holder can delegate this grant');
  }

  const p = {
    prev: await blockId(last),
    sub: opts.to,
    caveats: opts.caveats ?? [],
    iat: opts.iat ?? unixNow(),
  };

  return encodeGrant([
    ...blocks,
    { p, s: await sign(holder.seed, canonical(p)) },
  ]);
}

/**
 * Consent grant (SPEC §6.6): one-shot approval of one exact proposal. It is scoped to COMMIT
 * of that proposal's capability at that service, so it authorizes nothing else.
 */
export function consentGrant(opts: {
  principal: KeyPair | string;
  agent: string;
  consent: Pick<ConsentRequest, 'service' | 'capability' | 'hash' | 'expires'>;
}): Promise<string> {
  const c = opts.consent;

  return issueGrant({
    principal: opts.principal,
    to: opts.agent,
    caveats: [
      { svc: [c.service] },
      { verbs: ['COMMIT'] },
      { can: [c.capability] },
      { only: c.hash },
      { exp: c.expires },
    ],
  });
}

/**
 * A consent request packed for a human to approve out of band (`yea approve <code>`).
 * `detail` carries the full proposal (as the agent saw it) so the approver can show its
 * effects and re-check the hash, instead of trusting a service-written summary. `agent` is the
 * key the consent should be issued to, for approving on a machine without that agent's key; it
 * is unsigned, so `yea approve` shows it and checks it against a local agent key.
 */
export function consentCode(
  c: ConsentRequest,
  detail?: Omit<Proposal, 'data'>,
  o: { agent?: string } = {},
): string {
  const { data: _d, ...d } = (detail ?? {}) as Proposal;
  const body = {
    ...c,
    ...(detail ? { detail: d } : {}),
    ...(o.agent === undefined ? {} : { agent: o.agent }),
  };

  return encodeConsentCode(body);
}

/** An Ed25519 public key as YEA writes it (SPEC §6.1). */
export const isPublicKey = (v: unknown): v is string =>
  typeof v === 'string' && /^ed25519:[A-Za-z0-9_-]{43}$/.test(v);

/**
 * Who `yea approve` issues a protocol consent to: `--to` if given, else this machine's agent key
 * when the code names it or no one. The code's `agent` is unsigned, so it's never used on its
 * own: a code naming another key, or one on a machine without an agent key, needs `--to`.
 * Returns the key, or why there is none.
 */
export function consentRecipient(o: {
  code: unknown;
  local: string | null;
  to?: string;
}): { key: string } | { why: string } {
  const named = o.code === undefined || isPublicKey(o.code) ? o.code : null;

  if (named === null) {
    return { why: 'the code names an agent key that is not an ed25519 key' };
  }

  if (o.to !== undefined) {
    return isPublicKey(o.to)
      ? { key: o.to }
      : { why: '--to is not an ed25519 public key' };
  }

  if (!o.local) {
    return {
      why: 'no agent key on this machine: pass --to <key> to say which agent the consent is for',
    };
  }

  return named === undefined || named === o.local
    ? { key: o.local }
    : {
        why: `the code asks for a consent to agent ${named}, but this machine's agent key is ${o.local}; pass --to <key> to say which`,
      };
}

const CONSENT_PREFIX = 'pc1.';

/** A consent request, with whatever rides along (`detail`, `agent`), as a `pc1.` code. */
export const encodeConsentCode = (
  body: ConsentRequest & { detail?: unknown; agent?: unknown },
) => CONSENT_PREFIX + b64u(utf8(canonical(body)));

export function decodeConsentCode(
  code: string,
): ConsentRequest & { detail?: Proposal; agent?: unknown } {
  if (!code.startsWith(CONSENT_PREFIX)) {
    throw new Error('not a consent code (expected pc1.…)');
  }

  const c = JSON.parse(fromUtf8(unb64u(code.slice(CONSENT_PREFIX.length))));

  for (const k of [
    'proposal',
    'hash',
    'service',
    'capability',
    'principal',
    'summary',
  ]) {
    if (typeof c[k] !== 'string') {
      throw new Error(`consent code missing ${k}`);
    }
  }

  if (!Number.isSafeInteger(c.expires)) {
    throw new Error('consent code missing expires');
  }

  return c;
}

export interface GrantInfo {
  id: string;
  iss: string;
  holder: string;
  blocks: { id: string; sub: string; caveats: Caveat[]; iat: number }[];
}

export async function inspectGrant(token: string): Promise<GrantInfo> {
  const blocks = decodeGrant(token);
  const ids = await Promise.all(blocks.map(blockId));

  return {
    id: ids[0],
    iss: blocks[0].p.iss as string,
    holder: blocks[blocks.length - 1].p.sub,
    blocks: blocks.map((b, i) => ({
      id: ids[i],
      sub: b.p.sub,
      caveats: b.p.caveats,
      iat: b.p.iat,
    })),
  };
}

export interface CheckContext {
  service: string;
  verb: Verb;
  capability: string;
  now?: number;
  /** For COMMIT: the proposal being committed. */
  proposal?: { hash: string; uses?: Uses; risk: Risk };
  /** Principals the service trusts. */
  trusted: string[] | ((iss: string) => boolean);
  /** The key that signed the request proof; must equal the grant holder. */
  proofKey: string;
  /** The exact amount of measure `of` already committed or reserved under a block id (for `total`). */
  used?: (blockId: string, of: string) => bigint;
}

export type GrantCheck =
  | {
      ok: true;
      id: string;
      iss: string;
      holder: string;
      totals: TotalLimit[];
    }
  | {
      ok: false;
      code: 'unauthorized' | 'forbidden' | 'consent_required';
      reason: string;
      iss?: string;
      need?: Caveat[];
    };

/** A `total` caveat a COMMIT counts against: its block, measure and exact ceiling. */
export interface TotalLimit {
  id: string;
  of: string;
  max: bigint;
}

const CONSENTABLE = new Set(['each', 'total', 'risk']);

const strList = (v: unknown) =>
  Array.isArray(v) && v.every((x) => typeof x === 'string');

/** Shape validators for each known caveat's value. */
const VALID_CAVEAT: Record<string, (v: unknown) => boolean> = {
  svc: strList,
  verbs: strList,
  can: strList,
  exp: Number.isSafeInteger,
  nbf: Number.isSafeInteger,
  each: isLimit,
  total: isLimit,
  risk: isRisk,
  only: (v) => typeof v === 'string',
};

/** Caveats with malformed values fail closed (as a hard failure). */
function malformed(k: string, v: unknown, env: CaveatEnv): string | null {
  // unknown keys are handled by caveatDenial
  const ok = Object.hasOwn(VALID_CAVEAT, k) ? VALID_CAVEAT[k](v) : true;

  if (!ok) {
    return `malformed caveat ${JSON.stringify({ [k]: v })}`;
  }

  // A limit can't be judged against a malformed `uses` (SPEC §6.3), so that fails closed too.
  const p = env.p;
  const isLimitCaveat = k === 'each' || k === 'total';

  // `undefined` means absent; JSON can't carry it, so a `null` is still malformed.
  return isLimitCaveat && p && p.uses !== undefined && !isUses(p.uses)
    ? 'malformed uses on the proposal'
    : null;
}

function matchCapability(pattern: string, cap: string): boolean {
  return (
    pattern === '*' ||
    pattern === cap ||
    (pattern.endsWith('*') && cap.startsWith(pattern.slice(0, -1)))
  );
}

/** Verify a grant token against a request (SPEC §6.4). Never throws. */
export async function checkGrant(
  token: string,
  ctx: CheckContext,
): Promise<GrantCheck> {
  try {
    return await checkGrantUnsafe(token, ctx);
  } catch (e) {
    return {
      ok: false,
      code: 'forbidden',
      reason: `malformed grant content: ${(e as Error).message}`,
    };
  }
}

type GrantFailure = Extract<GrantCheck, { ok: false }>;

const unauthorized = (reason: string, iss?: string): GrantFailure => ({
  ok: false,
  code: 'unauthorized',
  reason,
  ...(iss === undefined ? {} : { iss }),
});

/** Check each block is chained to the previous one and signed by its holder; yields the final holder. */
async function verifyChain(
  blocks: Block[],
  iss: string,
): Promise<{ ok: true; holder: string } | GrantFailure> {
  let signer = iss;

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];

    if (i > 0 && b.p.prev !== (await blockId(blocks[i - 1]))) {
      return unauthorized(`block ${i} is not chained to block ${i - 1}`);
    }

    if (!(await verify(signer, canonical(b.p), b.s))) {
      return unauthorized(`bad signature on block ${i}`);
    }

    signer = b.p.sub;
  }

  return { ok: true, holder: signer };
}

/** What a caveat is checked against: the request, the time, and the block it sits in. */
interface CaveatEnv {
  ctx: CheckContext;
  t: number;
  /** The proposal, for COMMIT only. */
  p: CheckContext['proposal'];
  blockId: string;
}

/**
 * Per-key checks of a well-formed caveat value (already shape-validated by `malformed`):
 * why it denies the request, or null if it allows it.
 */
const CAVEAT_CHECKS: Record<
  string,
  (v: unknown, env: CaveatEnv) => string | null
> = {
  svc: (v, { ctx }) =>
    (v as string[]).includes(ctx.service)
      ? null
      : `not valid for service ${ctx.service}`,
  verbs: (v, { ctx }) =>
    (v as Verb[]).includes(ctx.verb) ? null : `does not allow ${ctx.verb}`,
  can: (v, { ctx }) =>
    (v as string[]).some((pat) => matchCapability(pat, ctx.capability))
      ? null
      : `does not cover ${ctx.capability}`,
  exp: (v, { t }) => (t < (v as number) ? null : 'grant has expired'),
  nbf: (v, { t }) => (t >= (v as number) ? null : 'grant is not valid yet'),
  each: (v, { p }) =>
    overLimit(p, v as Limit, 0n, 'over the per-commit limit of'),
  total: (v, { ctx, p, blockId }) => {
    const l = v as Limit;

    return overLimit(
      p,
      l,
      ctx.used?.(blockId, l.of) ?? 0n,
      'would pass the total limit of',
    );
  },
  risk: (v, { p }) =>
    p && !atLeast(v as Risk, p.risk)
      ? `risk ${p.risk} exceeds ceiling ${v}`
      : null,
  only: (v, { ctx, p }) =>
    ctx.verb === 'COMMIT' && p?.hash !== v
      ? 'grant is bound to a different proposal'
      : null,
};

/** The proposal's quantity of measure `of`, if it reports one. */
export function usedOf(uses: Uses | undefined, of: string) {
  return uses && Object.hasOwn(uses, of) ? uses[of] : undefined;
}

/**
 * Why the proposal's use of `l.of`, on top of `already`, breaks the limit `l` (SPEC §6.3);
 * null if it doesn't. A proposal that doesn't report the measure passes.
 */
function overLimit(
  p: CheckContext['proposal'],
  l: Limit,
  already: bigint,
  breaks: string,
): string | null {
  if (!p) {
    return null;
  }

  // `malformed` has already rejected a malformed `uses`.
  const q = usedOf(p.uses, l.of);

  if (!q) {
    return null;
  }

  if (!sameUnit(q, l)) {
    return `${l.of} is in ${q.unit ?? 'no unit'}, but the limit is in ${l.unit ?? 'no unit'}`;
  }

  return already + exact(q) > exact({ amount: l.max, scale: l.scale })
    ? `${l.of} ${breaks} ${fmtQuantity(limitQuantity(l))}`
    : null;
}

/** Why the single-key caveat `c` = `{k: v}` denies the request; unknown caveats always do. */
function caveatDenial(
  c: object,
  k: string,
  v: unknown,
  env: CaveatEnv,
): string | null {
  if (!Object.hasOwn(CAVEAT_CHECKS, k)) {
    return `unknown caveat ${JSON.stringify(c)}`;
  }

  return CAVEAT_CHECKS[k](v, env);
}

interface CaveatFailure {
  c: Caveat;
  why: string;
}

interface CaveatResults {
  /** Denials no one can override. */
  hard: CaveatFailure[];
  /** Denials a principal may approve (limits and risk ceilings). */
  soft: CaveatFailure[];
  /** `total` limits this COMMIT counts against. */
  totals: TotalLimit[];
}

/** Check one caveat, recording a denial (hard or soft) or the total it counts against. */
function evaluateCaveat(c: unknown, env: CaveatEnv, out: CaveatResults) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) {
    out.hard.push({
      c: c as Caveat,
      why: `malformed caveat ${JSON.stringify(c)}`,
    });

    return;
  }

  const keys = Object.keys(c);
  const k = keys.length === 1 ? keys[0] : '';
  const v = (c as Record<string, unknown>)[k];
  const bad = malformed(k, v, env);

  if (bad) {
    out.hard.push({ c: c as Caveat, why: bad });

    return;
  }

  const why = caveatDenial(c, k, v, env);

  if (why) {
    (CONSENTABLE.has(k) ? out.soft : out.hard).push({ c: c as Caveat, why });
  } else if (k === 'total' && env.ctx.verb === 'COMMIT') {
    const l = v as Limit;

    out.totals.push({
      id: env.blockId,
      of: l.of,
      max: exact({ amount: l.max, scale: l.scale }),
    });
  }
}

/** Check every caveat of every block. Fails closed: anything unrecognized is a hard denial. */
async function evaluateCaveats(
  blocks: Block[],
  ctx: CheckContext,
): Promise<CaveatResults> {
  const t = ctx.now ?? unixNow();
  const p = ctx.verb === 'COMMIT' ? ctx.proposal : undefined;
  const out: CaveatResults = { hard: [], soft: [], totals: [] };

  for (const b of blocks) {
    const env = { ctx, t, p, blockId: await blockId(b) };
    const caveats: unknown[] = b.p.caveats; // decoded but not yet validated

    for (const c of caveats) {
      evaluateCaveat(c, env, out);
    }
  }

  return out;
}

async function checkGrantUnsafe(
  token: string,
  ctx: CheckContext,
): Promise<GrantCheck> {
  let blocks: Block[];

  try {
    blocks = decodeGrant(token);
  } catch (e) {
    return unauthorized(`malformed grant: ${(e as Error).message}`);
  }

  const iss = blocks[0].p.iss;

  if (typeof iss !== 'string') {
    return unauthorized('root block has no iss');
  }

  const chain = await verifyChain(blocks, iss);

  if (!chain.ok) {
    return chain;
  }

  const trusted =
    typeof ctx.trusted === 'function'
      ? ctx.trusted(iss)
      : ctx.trusted.includes(iss);

  if (!trusted) {
    return unauthorized(
      'grant is issued by a principal this service does not trust',
      iss,
    );
  }

  if (chain.holder !== ctx.proofKey) {
    return unauthorized('proof key is not the grant holder', iss);
  }

  const { hard, soft, totals } = await evaluateCaveats(blocks, ctx);

  if (hard.length) {
    return {
      ok: false,
      code: 'forbidden',
      reason: hard.map((h) => h.why).join('; '),
      iss,
      need: hard.map((h) => h.c),
    };
  }

  if (soft.length) {
    return {
      ok: false,
      code: 'consent_required',
      reason: soft.map((h) => h.why).join('; '),
      iss,
    };
  }

  return {
    ok: true,
    id: await blockId(blocks[0]),
    iss,
    holder: chain.holder,
    totals,
  };
}

export interface ProofTarget {
  aud: string;
  verb: Verb;
  target: string;
}

export async function makeProof(
  seed: string,
  t: ProofTarget,
  ts = unixNow(),
): Promise<Proof> {
  const kp = await keyPair(seed);

  return {
    key: kp.public,
    ts,
    sig: await sign(
      seed,
      canonical({ aud: t.aud, verb: t.verb, target: t.target, ts }),
    ),
  };
}

export async function checkProof(
  proof: Proof | undefined,
  t: ProofTarget,
  at = unixNow(),
): Promise<string | null> {
  if (
    !proof ||
    typeof proof.key !== 'string' ||
    typeof proof.sig !== 'string' ||
    !Number.isSafeInteger(proof.ts)
  ) {
    return 'missing or malformed proof';
  }

  if (Math.abs(at - proof.ts) > 300) {
    return 'proof timestamp is outside the 300s window';
  }

  const ok = await verify(
    proof.key,
    canonical({ aud: t.aud, verb: t.verb, target: t.target, ts: proof.ts }),
    proof.sig,
  );

  return ok ? null : 'proof signature is invalid';
}
