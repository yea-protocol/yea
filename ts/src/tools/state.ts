/** What the `yea test-drive` tools share: the model's arguments, the host's state and the human approver. */
import type { Client } from '../client.js';
import type { Proposal } from '../types.js';

/**
 * Ask the human to approve `shown`: `at <service>:` and the proposal's Lens, escaped, as are
 * `service` and `reason`. Resolve true only on explicit approval.
 */
export type Approver = (req: {
  service: string;
  shown: string;
  reason: string;
}) => Promise<boolean>;

export interface ToolResult {
  text: string;
  isError?: boolean;
}

/** Tool arguments as the model sends them (see TOOLS); unchecked, like any model output. */
export interface ToolArgs {
  service: string;
  capability: string;
  params?: Record<string, unknown>;
  handle?: string;
  goal?: string;
  auto?: unknown;
  budget?: number;
  proposal: string;
  receipt: string;
}

export interface HostState {
  services: Map<string, Client>;
  // Remember each proposal as shown, so the model only handles short ids while COMMIT
  // (and any consent) still binds to exactly what was shown.
  seen: Map<string, { service: string; proposal: Proposal }>;
  approve?: Approver;
}

export type ToolFn = (
  s: HostState,
  c: Client,
  a: ToolArgs,
) => Promise<ToolResult>;
