/**
 * The bridge's MCP `instructions` (SPEC-bridge, "Tools"): how YEA tools behave, then a note per
 * service, where a generic service lists its capabilities within the budget.
 */
import { type Brief, est, untrustedLens } from '@yea-protocol/sdk';
import type { Service } from './greet.js';
import { clip } from './lens.js';
import { isGeneric, type ToolMode } from './tools/generic.js';
import type { ToolSpec } from './types.js';

// What the tools' own descriptions say (yea_undo, yea_expand) isn't repeated here, and the
// consent steps are given in full by the result that needs them; these lines are the rules.
const HEADER = `YEA acts for the user under a policy they signed.
- Read-only tools never change anything. Destructive tools act: call one with what the user asked for (names and days are fine; no lookups needed). It commits at once if the user's grant allows it (a ✓ receipt); otherwise it returns proposals, and nothing has happened.
- A proposal over the grant comes with a consent code: ask the user to run \`yea approve <code>\` where their principal key is, and pass the consent they paste back to yea_consent. Never split or restructure a purchase to get under a limit.
- \`preview: true\` only shows proposals; \`proposal: "<id>"\` commits one, with the same arguments, if the grant allows it; \`goal\` is the user's words. Commit only what the user asked for.`;

const NONE =
  'No YEA services are configured. Tell the user to run `npx @yea-protocol/cli add <url>` and restart.';

/**
 * A generic service's capabilities as its BRIEF's Lens, from the BRIEF kept at start-up: as
 * many full lines as fit `budget`, then the rest by name only.
 */
function capabilityList(svc: Service, budget: number): string {
  const brief: Brief = {
    ...svc.brief,
    capabilities: svc.capabilities.map((c) => ({
      ...c,
      summary: clip(c.summary),
    })),
    more: undefined,
  };
  const lines = untrustedLens(brief).split('\n');
  const head = lines.length - svc.capabilities.length;
  const kept = lines.slice(0, head);
  let used = est(kept.join('\n'));

  for (const line of lines.slice(head)) {
    used += est(line) + 1;

    if (used > budget) {
      break;
    }

    kept.push(line);
  }

  const rest = svc.capabilities.slice(kept.length - head).map((c) => c.name);

  return rest.length
    ? `${kept.join('\n')}\n… ${rest.length} more: ${clip(rest.join(', '), budget * 4)}`
    : kept.join('\n');
}

/** A service's part of the instructions; a generic one lists its capabilities (fitted). */
function serviceNote(
  svc: Service,
  o: { generic: boolean; tools: string[]; budget: number },
): string {
  if (!o.generic) {
    return `# ${clip(svc.name, 100)} (${clip(svc.id, 100)})\n${clip(svc.summary)}`;
  }

  return `${capabilityList(svc, o.budget)}\nUse ${o.tools.join(' and ')} with a capability from this list.`;
}

export function instructionsFor(
  services: Service[],
  specs: ToolSpec[],
  o: { mode: ToolMode; budget: number; problems: string[] },
): string {
  const notes = services.map((svc) =>
    serviceNote(svc, {
      generic: isGeneric(svc, o.mode),
      tools: specs
        .filter((t) => t.meta['dev.yea/service'] === svc.id)
        .map((t) => t.name),
      budget: o.budget,
    }),
  );

  return [HEADER, notes.length ? notes.join('\n\n') : NONE, ...o.problems]
    .join('\n\n')
    .trim();
}
