/**
 * Start-up (SPEC-bridge, "Tools"): `HELLO` each service with a large budget and `EXPAND` its
 * `more` handles, so the bridge has every capability and its params. Service ids must be unique.
 */
import {
  type Brief,
  type CapabilityInfo,
  type Client,
  keyPair,
  type More,
  printable,
} from '@yea-protocol/sdk';

/** Large enough that a service lists every capability with its params at once. */
const HELLO_BUDGET = 100_000;

/** A hostile service can't keep the bridge expanding forever. */
const MAX_EXPANDS = 64;

/** A service the bridge serves: its client, its BRIEF, and every capability. */
export interface Service {
  id: string;
  url: string;
  name: string;
  summary: string;
  client: Client;
  /** The agent's public key, or null when the bridge has none (it can then only read). */
  agent: string | null;
  capabilities: CapabilityInfo[];
}

type Obj = Record<string, unknown>;

const isObject = (v: unknown): v is Obj =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** A capability entry the bridge can build a tool from; anything else is skipped. */
const isCapability = (c: unknown): c is CapabilityInfo =>
  isObject(c) &&
  typeof c.name === 'string' &&
  (c.kind === 'ask' || c.kind === 'intent') &&
  (c.summary === undefined || typeof c.summary === 'string');

/** Only the entries that parse, each name once (a repeat is a hostile or broken BRIEF). */
function usable(entries: unknown[], problems: string[], id: string) {
  const seen = new Set<string>();
  const out: CapabilityInfo[] = [];

  for (const c of entries) {
    if (!isCapability(c) || seen.has(c.name)) {
      problems.push(
        `${printable(id)}: skipped a malformed or repeated capability entry`,
      );

      continue;
    }

    seen.add(c.name);
    out.push({ ...c, summary: c.summary ?? '' });
  }

  return out;
}

/** The items of one `EXPAND` of the capabilities list, and any further handles. */
async function expandOnce(c: Client, m: More) {
  const r = await c.expand(m.handle, { budget: HELLO_BUDGET });

  if (
    r.kind !== 'ANSWER' ||
    !isObject(r.data) ||
    !Array.isArray(r.data.items)
  ) {
    throw new Error(`EXPAND ${m.handle} did not return the capability list`);
  }

  return { items: r.data.items as unknown[], more: r.more ?? [] };
}

/** Every capability entry: the BRIEF's, then each elided part, expanded. */
async function allEntries(c: Client, b: Brief): Promise<unknown[]> {
  const entries: unknown[] = [...b.capabilities];
  const queue = [...(b.more ?? [])];

  for (let n = 0; queue.length; n++) {
    const m = queue.shift();

    if (!m || n >= MAX_EXPANDS) {
      throw new Error('too many EXPANDs to list its capabilities');
    }

    const got = await expandOnce(c, m);

    entries.push(...got.items);
    queue.push(...got.more);
  }

  return entries;
}

/** HELLO one service and read all of its capabilities. */
async function greetOne(
  c: Client,
  url: string,
  problems: string[],
): Promise<Service> {
  const b = await c.hello(HELLO_BUDGET);

  if (b.kind !== 'BRIEF') {
    throw new Error(`it answered HELLO with ${b.code}: ${b.message}`);
  }

  const id = b.service.id;

  return {
    id,
    url,
    name: String(b.service.name ?? id),
    summary: String(b.service.summary ?? ''),
    client: c,
    agent: c.key ? (await keyPair(c.key)).public : null,
    capabilities: usable(await allEntries(c, b), problems, id),
  };
}

/** Refuse two services claiming one id: proofs and consents bind to it (SPEC-bridge). */
function checkUnique(services: Service[]) {
  const byId = new Map<string, string>();

  for (const s of services) {
    const other = byId.get(s.id);

    if (other !== undefined) {
      throw new Error(
        `yea mcp: ${printable(other)} and ${printable(s.url)} both claim the service id ${printable(JSON.stringify(s.id))}; refusing to start`,
      );
    }

    byId.set(s.id, s.url);
  }
}

/** Greet every service. Unreachable ones are reported in `problems`; duplicates refuse. */
export async function greet(
  clients: { client: Client; url: string }[],
): Promise<{ services: Service[]; problems: string[] }> {
  const services: Service[] = [];
  const problems: string[] = [];

  for (const { client, url } of clients) {
    try {
      services.push(await greetOne(client, url, problems));
    } catch (e) {
      problems.push(
        `${printable(url)} could not be reached: ${printable((e as Error).message)}`,
      );
    }
  }

  checkUnique(services);

  return { services, problems };
}
