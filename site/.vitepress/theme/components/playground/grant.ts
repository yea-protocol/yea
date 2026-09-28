/**
 * The human's policy as the playground edits it, and how it becomes the caveats of a real,
 * signed grant (SPEC §6), plus the short forms the policy panel shows.
 */
import type { Caveat, GrantInfo, Limit, Risk } from '@yea-protocol/sdk';
import { SERVICE_KEYS, SERVICES, type ServiceKey } from './model';

/** The policy panel's fields: which services, the highest risk, USD limits and a lifetime. */
export interface PolicyForm extends Record<ServiceKey, boolean> {
  risk: Risk;
  each: string;
  total: string;
  exp: string;
}

const SECONDS = { m: 60, h: 3600, d: 86400 } as const;

/** A USD spend limit from a text field, in cents. */
const usd = (s: string): Limit => ({
  of: 'spend',
  max: Math.round(Number(s) * 100),
  scale: 2,
  unit: 'USD',
});

/** Whether a limit field holds a usable amount (blank means no limit). */
const isAmount = (s: string) => s !== '' && Number(s) >= 0;

/** The `exp` caveat for a lifetime like `8h`, or null when it doesn't parse. */
function expiry(lifetime: string): Caveat | null {
  const m = /^(\d+)([mhd])$/.exec(lifetime);

  if (!m) {
    return null;
  }

  const unit = m[2] as keyof typeof SECONDS;

  return { exp: Math.floor(Date.now() / 1000) + Number(m[1]) * SECONDS[unit] };
}

/** The grant's caveats, in the order the panel lists them. */
export function caveatsFor(policy: PolicyForm): Caveat[] {
  const out: Caveat[] = [
    { svc: SERVICE_KEYS.filter((s) => policy[s]).map((s) => SERVICES[s]) },
  ];

  if (policy.risk) {
    out.push({ risk: policy.risk });
  }

  if (isAmount(policy.each)) {
    out.push({ each: usd(policy.each) });
  }

  if (isAmount(policy.total)) {
    out.push({ total: usd(policy.total) });
  }

  const exp = expiry(policy.exp);

  if (exp) {
    out.push(exp);
  }

  return out;
}

/** A grant token cut to its head and tail. */
export const shortGrant = (token: string) =>
  token ? `${token.slice(0, 28)}…${token.slice(-8)}` : '';

/** The root block's caveats, one JSON line each. */
export const caveatLines = (info: GrantInfo | null) =>
  info ? info.blocks[0].caveats.map((c) => JSON.stringify(c)).join('\n') : '';
