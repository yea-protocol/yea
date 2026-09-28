/** Small helpers the job plugin and the bridge share. Internal: not part of the package's API. */
import type { McpServer } from '@modelcontextprotocol/server';

export type Obj = Record<string, unknown>;

/** A plain object: not null, and not an array. */
export const isObject = (v: unknown): v is Obj =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** What was thrown, as text: an Error's message, or anything else as a string. */
export const errorMessage = (e: unknown) =>
  e instanceof Error ? e.message : String(e);

const warned = new Set<string>();

/** Warn on stderr, once per message, so a per-call read doesn't flood the log. */
export function warnOnce(message: string) {
  if (!warned.has(message)) {
    warned.add(message);
    console.error(`yea: ${message}`);
  }
}

/** A Node error's `code`, such as `ENOENT`. */
export const errno = (e: unknown) => (e as NodeJS.ErrnoException).code;

/**
 * The server's tool registry. SDK seam: `RegisteredTool` doesn't carry its name and the registry
 * is private, so this reads it through a narrow cast; an empty object if it isn't there.
 */
export function registryOf(server: McpServer): Record<string, unknown> {
  const registry = (server as unknown as { _registeredTools?: unknown })
    ._registeredTools;

  return registry && typeof registry === 'object'
    ? (registry as Record<string, unknown>)
    : {};
}
