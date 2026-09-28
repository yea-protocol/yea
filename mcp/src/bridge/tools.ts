/**
 * The bridge's tools (SPEC-bridge, "Tools"): one per remote capability, or two generic ones for
 * a service past 25 capabilities, plus the utilities. Built once at start, from `HELLO`.
 */
import type {
  CallToolResult,
  ServerContext,
  ToolAnnotations,
} from '@modelcontextprotocol/server';
import { type CapabilityInfo, printable } from '@yea-protocol/sdk';
import {
  errorResult,
  JOB_ANNOTATIONS,
  NOTHING_RAN,
  READ_ANNOTATIONS,
  refused,
} from '../result.js';
import { errorMessage, isObject, type Obj, warnOnce } from '../util.js';
import type { Service } from './greet.js';
import { type Bridge, type JobCall, runJobCall } from './job.js';
import { assignNames, genericBase, sanitize, type ToNames } from './names.js';
import {
  badParamNames,
  genericSchema,
  objectSchema,
  reservedParams,
  withJobFields,
} from './params.js';
import { clip } from './render.js';
import { readCall } from './utility.js';

/** Past this many capabilities, a service gets two generic tools instead (decision 1). */
export const GENERIC_PAST = 25;

export type ToolMode = 'auto' | 'generic' | 'per-capability';

/** A tool as the server factory registers it. */
export interface ToolSpec {
  name: string;
  description: string;
  schema: Obj;
  annotations: ToolAnnotations;
  meta: Obj;
  run(args: Obj, ctx: ServerContext): Promise<CallToolResult>;
}

type Unnamed = Omit<ToolSpec, 'name'>;

/** Any approval state on a job call: the bridge mints none yet (TODO(#73)). */
const UNMINTED_STATE = `this approval state is invalid, expired or already used; ${NOTHING_RAN}. Call the tool again without it.`;

/** Whether a service gets the two generic tools. */
export const isGeneric = (svc: Service, mode: ToolMode) =>
  mode === 'generic' ||
  (mode === 'auto' && svc.capabilities.length > GENERIC_PAST);

/** A call's capability, its params, and the job's own fields; or why the arguments are wrong. */
type Picked =
  | { capability: string; params: Obj; fields: Obj }
  | { why: string };

/** The job's own fields, and everything else. */
function split(args: Obj) {
  const { goal, preview, proposal, ...rest } = args;

  return { fields: { goal, preview, proposal }, rest };
}

/** The job's own fields, type-checked; or why they're wrong. */
function jobFields(
  f: Obj,
): Pick<JobCall, 'goal' | 'preview' | 'proposal'> | { why: string } {
  const { goal, preview, proposal } = f;

  if (goal !== undefined && typeof goal !== 'string') {
    return { why: 'goal must be a string' };
  }

  if (preview !== undefined && typeof preview !== 'boolean') {
    return { why: 'preview must be true or false' };
  }

  if (proposal !== undefined && typeof proposal !== 'string') {
    return { why: 'proposal must be a proposal id' };
  }

  return { goal, preview: preview === true, proposal };
}

/**
 * A job tool's handler. It never takes an approval state: the bridge mints none until
 * `--approve-here` (TODO(#73)), so any state is refused and never falls through to an INTENT.
 */
function jobHandler(
  b: Bridge,
  base: { tool: string; svc: Service },
  pick: (args: Obj) => Picked,
) {
  return async (args: Obj, ctx: ServerContext): Promise<CallToolResult> => {
    if (ctx.mcpReq.requestState() !== undefined) {
      return errorResult([`✗ ${UNMINTED_STATE}`]);
    }

    const picked = pick(args);

    if ('why' in picked) {
      return refused(picked.why);
    }

    const fields = jobFields(picked.fields);

    if ('why' in fields) {
      return refused(fields.why);
    }

    return runJobCall(b, {
      ...base,
      capability: picked.capability,
      params: picked.params,
      ...fields,
    });
  };
}

/** The description a model sees: the service's summary, one line, and where it runs. */
const describe = (svc: Service, cap: CapabilityInfo) =>
  `${clip(cap.summary || cap.name)} (${clip(cap.name, 100)} at ${clip(svc.id, 100)})`;

/** In per-capability mode a service gets at most this many tools. */
export const MAX_TOOLS_PER_SERVICE = 200;

/** Why a capability's tool can't be built from its params, or null. */
function paramProblem(cap: CapabilityInfo): string | null {
  const bad = badParamNames(cap.params);

  if (bad.length) {
    return `its param name ${clip(bad.join(', '), 100)} isn't [a-zA-Z0-9_.-]{1,64}, which some model APIs require`;
  }

  const reserved = cap.kind === 'intent' ? reservedParams(cap.params) : [];

  return reserved.length
    ? `its param ${reserved.join(', ')} would shadow the bridge's own field`
    : null;
}

const meta = (svc: Service, capability?: string) => ({
  'dev.yea/service': svc.id,
  ...(capability === undefined ? {} : { 'dev.yea/capability': capability }),
});

/** One capability's tool, or null (said on stderr) when its params can't be served. */
function capabilityTool(
  b: Bridge,
  svc: Service,
  cap: CapabilityInfo,
): ((name: string) => Unnamed) | null {
  const problem = paramProblem(cap);

  if (problem) {
    warnOnce(
      `not serving ${clip(svc.id, 100)}/${clip(cap.name, 100)}: ${problem}`,
    );

    return null;
  }

  const schema = objectSchema(cap.params);

  if (cap.kind === 'ask') {
    return () => ({
      description: describe(svc, cap),
      schema,
      annotations: READ_ANNOTATIONS,
      meta: meta(svc, cap.name),
      run: (args) =>
        readCall(svc, { capability: cap.name, params: args, budget: b.budget }),
    });
  }

  return (name) => ({
    description: describe(svc, cap),
    schema: withJobFields(schema),
    annotations: JOB_ANNOTATIONS,
    meta: meta(svc, cap.name),
    run: jobHandler(b, { tool: name, svc }, (args) => {
      const { fields, rest } = split(args);

      return { capability: cap.name, params: rest, fields };
    }),
  });
}

/** A generic tool's `capability` and `params`, checked against the service's own list. */
function genericPick(svc: Service, kind: 'ask' | 'intent') {
  return (args: Obj): Picked => {
    const { fields, rest } = split(args);
    const { capability, params } = rest;
    const known = svc.capabilities.some(
      (c) => c.name === capability && c.kind === kind,
    );

    if (typeof capability !== 'string' || !known) {
      return {
        why: `${clip(String(capability), 100)} is not one of ${clip(svc.id, 100)}'s ${kind} capabilities`,
      };
    }

    if (params !== undefined && !isObject(params)) {
      return { why: 'params must be an object' };
    }

    return { capability, params: params ?? {}, fields };
  };
}

/** `<service>_ask` or `<service>_intent`, taking `{ capability, params, … }`. */
function genericTool(b: Bridge, svc: Service, kind: 'ask' | 'intent') {
  const pick = genericPick(svc, kind);
  const description = `${kind === 'ask' ? 'Read from' : 'Do something at'} ${clip(svc.name, 100)} (${clip(svc.id, 100)}): pass one of its ${kind} capabilities (listed in the instructions) and its params.`;

  if (kind === 'ask') {
    return (): Unnamed => ({
      description,
      schema: genericSchema(kind),
      annotations: READ_ANNOTATIONS,
      meta: meta(svc),
      run: async (args) => {
        const p = pick(args);

        return 'why' in p
          ? errorResult([`✗ ${p.why}`])
          : readCall(svc, {
              capability: p.capability,
              params: p.params,
              budget: b.budget,
            });
      },
    });
  }

  return (name: string): Unnamed => ({
    description,
    schema: genericSchema(kind),
    annotations: JOB_ANNOTATIONS,
    meta: meta(svc),
    run: jobHandler(b, { tool: name, svc }, pick),
  });
}

/** The tools one service gets, before naming. */
function serviceTools(
  b: Bridge,
  svc: Service,
  mode: ToolMode,
): { names: ToNames; build: (name: string) => Unnamed }[] {
  if (isGeneric(svc, mode)) {
    return (['ask', 'intent'] as const)
      .filter((k) => svc.capabilities.some((c) => c.kind === k))
      .map((k) => ({
        names: { service: svc.id, capability: k, base: genericBase(svc.id, k) },
        build: genericTool(b, svc, k),
      }));
  }

  if (svc.capabilities.length > MAX_TOOLS_PER_SERVICE) {
    warnOnce(
      `${clip(svc.id, 100)}: serving its first ${MAX_TOOLS_PER_SERVICE} of ${svc.capabilities.length} capabilities as tools; use --tools generic for all of them`,
    );
  }

  return svc.capabilities.slice(0, MAX_TOOLS_PER_SERVICE).flatMap((cap) => {
    const build = capabilityTool(b, svc, cap);

    return build
      ? [
          {
            names: {
              service: svc.id,
              capability: cap.name,
              base: sanitize(cap.name),
            },
            build,
          },
        ]
      : [];
  });
}

/** Every remote tool, named (SPEC-bridge naming); a tool whose name still clashes is left out. */
export async function buildTools(
  b: Bridge,
  services: Service[],
  mode: ToolMode,
): Promise<ToolSpec[]> {
  const all = services.flatMap((s) => serviceTools(b, s, mode));
  const names = await assignNames(all.map((t) => t.names));

  return all.flatMap((t, i) => {
    const name = names[i];

    if (name === null) {
      warnOnce(
        `not serving ${printable(t.names.service)}/${printable(t.names.capability)}: its tool name clashes with another`,
      );

      return [];
    }

    return [{ name, ...t.build(name) }];
  });
}

export const errorOf = (e: unknown) =>
  errorResult([`✗ ${printable(errorMessage(e))}`]);
