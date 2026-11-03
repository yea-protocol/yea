/**
 * `YEA_REQUIRE_INTERACTION`, which has the bridge mark the tools that change things for Claude
 * Code's prompt on every call: its values, read one way by `yea mcp`, `yea install` and `yea
 * doctor`, and the reference the Claude Code plugin passes it on with.
 */

/**
 * The env that has the bridge mark the tools that change things for Claude Code's prompt on every
 * call (`yea mcp --require-interaction`). Not personal, so a project file may carry it.
 */
export const REQUIRE_INTERACTION_ENV: Readonly<Record<string, string>> =
  Object.freeze({ YEA_REQUIRE_INTERACTION: '1' });

/**
 * `YEA_REQUIRE_INTERACTION`'s values and what each means, for `yea mcp`, `yea install` and `yea
 * doctor` alike. Unset reads as empty; any other value is refused, not read as off.
 */
export const REQUIRE_INTERACTION_VALUES: Readonly<Record<string, boolean>> =
  Object.freeze({ '1': true, true: true, '0': false, false: false, '': false });

/**
 * How the Claude Code plugin's entry passes the variable on: Claude Code expands it from the
 * environment it was started in, to empty when the variable is unset.
 */
// biome-ignore lint/suspicious/noTemplateCurlyInString: Claude Code's reference syntax, not a template.
export const REQUIRE_INTERACTION_REFERENCE = '${YEA_REQUIRE_INTERACTION:-}';

/**
 * The `YEA_REQUIRE_INTERACTION` an entry's value `v` gives the bridge: the plugin's reference
 * expanded from `env`, as Claude Code expands it, and any other value as it is.
 */
export const expandInteraction = (
  v: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined =>
  v === REQUIRE_INTERACTION_REFERENCE ? (env.YEA_REQUIRE_INTERACTION ?? '') : v;

/** Whether `YEA_REQUIRE_INTERACTION=v` turns the prompt on; null if `v` isn't one of its values. */
export const requiresInteraction = (v: string | undefined): boolean | null =>
  Object.hasOwn(REQUIRE_INTERACTION_VALUES, v ?? '')
    ? REQUIRE_INTERACTION_VALUES[v ?? '']
    : null;
