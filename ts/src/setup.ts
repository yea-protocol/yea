/**
 * `yea install|uninstall`: register the YEA MCP bridge (plus agent instructions) with AI tools, and
 * `yea add/remove/services`: manage the services it exposes (~/.yea/services.json).
 * The parts live in setup/; this file finds the installed tools.
 */
import { CLIENTS } from './setup/clients.js';

export { CLIENTS } from './setup/clients.js';
export { AGENT_BLOCK } from './setup/instructions.js';

export {
  addService,
  listServices,
  removeService,
} from './setup/registry.js';

export type { Scope } from './setup/target.js';

export function detectedClients(): string[] {
  return Object.entries(CLIENTS)
    .filter(([, c]) => c.detect())
    .map(([k]) => k);
}
