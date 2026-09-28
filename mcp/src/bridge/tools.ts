/**
 * The bridge's tools (SPEC-bridge, "Tools"): one per remote capability, or two generic ones for
 * a service past 25 capabilities, plus the utilities. Built once at start, from `HELLO`.
 *
 * This file picks a service's tools and names them. The tools themselves are in tools/: one
 * per capability (capability.ts), or the two generic ones (generic.ts), each its spec, then its
 * handler, over the shared job handler (job-handler.ts) and in the shape of spec.ts.
 */
import { printable } from '@yea-protocol/sdk';
import { errorResult } from '../result.js';
import { errorMessage, warnOnce } from '../util.js';
import type { Service } from './greet.js';
import { clip } from './lens.js';
import { assignNames, genericBase, sanitize, type ToNames } from './names.js';
import type { Bridge } from './state.js';
import { capabilityTool } from './tools/capability.js';
import { genericTool, isGeneric, type ToolMode } from './tools/generic.js';
import type { Unnamed } from './tools/spec.js';
import type { ToolSpec } from './types.js';

/** In per-capability mode a service gets at most this many tools. */
export const MAX_TOOLS_PER_SERVICE = 200;

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
