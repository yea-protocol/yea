/**
 * Runs one call of ../conformance/job-calls.json through `jobCall`, a round per step, and returns
 * what each step did as the vectors record it: the store before, the outcome, whether the
 * handler ran, and the store after. The first step's `before` sets the store up; the ledger
 * entries it lists are the ones each snapshot reads. The generator (job-call-vectors.mjs) and the TS conformance
 * test share it; python/tests/test_job_call_conformance.py is its Python twin.
 *
 * The store is a MemoryStore behind a plain object (so the session doesn't treat it as one: it
 * issues consent codes) that records each id it consumes. A step's `race` is reserved by
 * "another call" just before the session's first reservation, after the policy has decided.
 */

/** Room for any race reservation. */
const NO_MAX = 10n ** 40n;

const keyOf = (id) => {
  const [block, of] = id.split(' ');

  return { block, of };
};

/** A recording store over a MemoryStore, set up as the first step's `before` says. */
async function storeFor(P, call) {
  const setup = call.steps[0].before;
  const inner = new P.MemoryStore();
  const consumed = [];
  const race = [];
  const store = Object.fromEntries(
    [
      'putReceipt',
      'getReceipt',
      'claimUndo',
      'releaseUndo',
      'markUndone',
      'settle',
      'release',
      'used',
      'putConsent',
      'getConsent',
    ].map((m) => [m, inner[m].bind(inner)]),
  );

  store.consumeOnce = async (id, exp) => {
    const fresh = await inner.consumeOnce(id, exp);

    if (fresh) {
      consumed.push(id);
    }

    return fresh;
  };
  store.reserve = async (key, amount, max) => {
    for (const r of race.splice(0)) {
      await inner.reserve(keyOf(r.key), BigInt(r.amount), NO_MAX);
    }

    return inner.reserve(key, amount, max);
  };

  for (const [id, amount] of Object.entries(setup.used)) {
    const r = await inner.reserve(keyOf(id), BigInt(amount), NO_MAX);

    await inner.settle(r);
  }

  for (const id of setup.consumed) {
    await store.consumeOnce(id, Number.MAX_SAFE_INTEGER);
  }

  for (const [hash, grant] of Object.entries(call.consents ?? {})) {
    await inner.putConsent(hash, grant);
  }

  return { store, consumed, race, inner };
}

/** An outcome as the vectors record it: plans by hash, a state without its random nonce. */
function project(o) {
  const hashes = (plans) => plans.map((hp) => hp.planHash);

  switch (o.kind) {
    case 'clarify':
      return { kind: o.kind, clarify: o.clarification.clarify };
    case 'preview':
      return { kind: o.kind, plans: hashes(o.plans) };
    case 'run':
      return {
        kind: o.kind,
        plan: o.plan.planHash,
        how: o.how,
        held: o.held.map((r) => ({ key: r.key, amount: String(r.amount) })),
      };
    case 'ask': {
      const { nonce: _random, ...state } = o.state;

      return { kind: o.kind, form: o.form, state };
    }
    case 'consent-codes':
      return {
        kind: o.kind,
        why: o.why,
        plans: hashes(o.plans),
        codes: o.codes.map((c) => c.planHash),
        unavailable: o.unavailable,
      };
    case 'refuse':
      return { kind: o.kind, why: o.why, ...(o.again ? { again: true } : {}) };
    default:
      throw new Error(`unknown outcome ${o.kind}`);
  }
}

/** The tool as the session takes it: `revert` as a flag, phrases by plan hash. */
const toolOf = (t) => ({
  name: t.name,
  ...(t.risk ? { risk: t.risk } : {}),
  ...(t.revert ? { revert: () => null } : {}),
  ...(t.phrases ? { confirmWith: (hp) => t.phrases[hp.planHash] ?? '' } : {}),
});

/** A step's handler: its plans (each `apply` a no-op) or its clarification, noting it ran. */
const handlerOf = (step, ran) => () => {
  ran.planned = true;

  return Array.isArray(step.plans)
    ? step.plans.map((p) => ({ ...p, apply: () => null }))
    : step.plans;
};

/** Each step's `{ before, outcome, planned, after }`. */
export async function runCall(P, call) {
  const s = await storeFor(P, call);
  const states = new Map();
  const nonces = new Map();
  const snapshot = async () => ({
    used: Object.fromEntries(
      await Promise.all(
        Object.keys(call.steps[0].before.used).map(async (id) => [
          id,
          String(await s.inner.used(keyOf(id))),
        ]),
      ),
    ),
    consumed: s.consumed.map((id) =>
      nonces.has(id) ? `nonce of step ${nonces.get(id)}` : id,
    ),
  });
  const out = [];

  for (const [i, step] of call.steps.entries()) {
    const before = await snapshot();
    const ran = { planned: false };
    const retry = step.retry && {
      state:
        typeof step.retry.state === 'object' && 'fromStep' in step.retry.state
          ? states.get(step.retry.state.fromStep)
          : step.retry.state,
      answer: step.retry.answer,
    };

    s.race.splice(0, s.race.length, ...(step.race ?? []));

    const o = await P.jobCall(
      {
        tool: toolOf(call.tool),
        input: step.input,
        plan: handlerOf(step, ran),
        ...(step.preview ? { preview: true } : {}),
        sub: step.sub,
        now: step.now,
        policy: step.policy,
        canAsk: step.canAsk,
        ...(step.unpinned ? { unpinned: step.unpinned } : {}),
      },
      s.store,
      retry,
    );

    if (o.kind === 'ask') {
      states.set(i + 1, o.state);
      nonces.set(o.state.nonce, i + 1);
    }

    out.push({
      before,
      outcome: project(o),
      planned: ran.planned,
      after: await snapshot(),
    });
  }

  return out;
}
