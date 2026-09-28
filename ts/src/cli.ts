#!/usr/bin/env node
import { createInterface, type Interface } from 'node:readline/promises';
/** yea — command line for the YEA protocol. */
import { parseArgs } from 'node:util';
import {
  type JobConsent,
  phraseMatches,
  readJobConsent,
  signJobConsent,
} from './ask.js';
import type { Client } from './client.js';
import type { KeyPair } from './crypto.js';
import { proposalHash } from './crypto.js';
import { FileStore } from './filestore.js';
import {
  type Caveat,
  consentGrant,
  decodeConsentCode,
  delegateGrant,
  type GrantInfo,
  inspectGrant,
  issueGrant,
} from './grants.js';
import { agentKey, home, loadGrants, principalKey, saveGrant } from './home.js';
import { effectLine, fmtDuration, fmtTime, lean, lens } from './lens.js';
import { runMcpBridge } from './mcp.js';
import { connect } from './node.js';
import {
  addService,
  CLIENTS,
  detectedClients,
  listServices,
  removeService,
} from './setup.js';
import type { ConsentRequest, Proposal, Risk, Verb } from './types.js';
import { fmtUses, isLimit, isUses, type Limit } from './uses.js';

const HELP = `yea — the protocol agents speak

get started
  yea install [--target claude-code,cursor,codex,gemini,vscode,windsurf,claude-desktop] [--local] [--with-principal]
                                           keys, a safe default policy, the MCP bridge and agent instructions (auto-detects tools)
  yea add <url>                         add a service for your AI tools (yea services · yea remove <url>)
  yea doctor                            check keys, grants, services and AI-tool registration
  yea uninstall [--target …]            remove YEA from your AI tools

identity
  yea init                              create your principal key and an agent key in ${home()}
  yea whoami                            show public keys
  yea grant [caveats]                   principal → agent grant (saved; used automatically)
  yea grant-import <token>              save a grant issued to this machine's agent key (principal kept elsewhere)
  yea delegate <token> --to <key> [caveats]   attenuate a grant for a sub-agent
  yea inspect <token>                   decode a grant chain
  yea approve <pc1.code>                review and sign a one-time consent for one proposal

talk to a service  (url: yea://host:port · yeas://… · http(s)://…/yea · "stdio:cmd args")
  yea hello  <url>
  yea ask    <url> <capability> [key=value …]
  yea intent <url> <capability> [key=value …] [--goal "…"]
  yea commit <url> <proposal-id> <hash>
  yea undo   <url> <receipt-id>
  yea expand <url> <handle>
  yea do     <url> <capability> [key=value …]   intent → choose → commit, with consent prompts

try it
  yea test-drive [--model m] ["task"]  watch a real Claude model use YEA live (needs an Anthropic API key)
  yea demo                              narrated end-to-end demo (two services, consent, undo, sub-agents)
  yea examples [--port 7447] [--host]            serve the example calendar (7447), shop (7449) and billing (7451), trusting your principal

bridges
  yea mcp <url> [<url> …]               run an MCP server (stdio) exposing YEA services
  yea openapi <spec.json|url> [--base <url>] [--header "K: V"] [--port 7447] [--http 8080] [--preset github|petstore]
                                           serve any REST API as a YEA service (writes become proposals)

caveats: --svc <id> --can <pattern> --verbs ASK,INTENT --exp 24h --each spend=50.00USD --total emails=20 --risk low|medium|high
options: --budget <tokens> --json`;

const { values: o, positionals: args } = parseArgs({
  allowPositionals: true,
  options: {
    svc: { type: 'string', multiple: true },
    can: { type: 'string', multiple: true },
    verbs: { type: 'string' },
    exp: { type: 'string' },
    each: { type: 'string', multiple: true },
    total: { type: 'string', multiple: true },
    risk: { type: 'string' },
    to: { type: 'string' },
    goal: { type: 'string' },
    budget: { type: 'string' },
    expires: { type: 'string' },
    json: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
    name: { type: 'string' },
    model: { type: 'string' },
    base: { type: 'string' },
    header: { type: 'string', multiple: true },
    port: { type: 'string' },
    http: { type: 'string' },
    id: { type: 'string' },
    prefix: { type: 'string' },
    target: { type: 'string' },
    local: { type: 'boolean' },
    yes: { type: 'boolean', short: 'y' },
    'no-principal': { type: 'boolean' },
    'with-principal': { type: 'boolean' },
    host: { type: 'string' },
    preset: { type: 'string' },
  },
});

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function duration(s: string): number {
  const m =
    /^(\d+)([smhd])$/.exec(s) ??
    die(`bad duration ${s} (use e.g. 30m, 24h, 7d)`);

  return Number(m[1]) * { s: 1, m: 60, h: 3600, d: 86400 }[m[2] as 's'];
}

/** `spend=25.00USD` or `emails=20` → a limit on that measure (SPEC §6.3). */
function limit(s: string): Limit {
  const m =
    /^([a-z][a-z0-9_.-]*)=(\d+)(?:\.(\d+))?\s*([A-Za-z%][A-Za-z0-9_./%-]*)?$/.exec(
      s,
    ) ?? die(`bad limit ${s} (use e.g. spend=25.00USD or emails=20)`);
  const decimals = m[3] ?? '';
  const l = {
    of: m[1],
    max: Number(m[2] + decimals),
    ...(decimals ? { scale: decimals.length } : {}),
    ...(m[4] ? { unit: m[4] } : {}),
  };

  return isLimit(l) ? l : die(`bad limit ${s} (amount or unit out of range)`);
}

function caveats(): Caveat[] {
  const c: Caveat[] = [];

  if (o.svc) {
    c.push({ svc: o.svc });
  }

  if (o.can) {
    c.push({ can: o.can });
  }

  if (o.verbs) {
    c.push({
      verbs: o.verbs.split(',').map((v) => v.trim().toUpperCase()) as Verb[],
    });
  }

  if (o.exp) {
    c.push({ exp: Math.floor(Date.now() / 1000) + duration(o.exp) });
  }

  for (const l of o.each ?? []) {
    c.push({ each: limit(l) });
  }

  for (const l of o.total ?? []) {
    c.push({ total: limit(l) });
  }

  if (o.risk) {
    c.push({ risk: o.risk as Risk });
  }

  return c;
}

function kv(pairs: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (const p of pairs) {
    const i = p.indexOf('=');

    if (i < 0) {
      die(`expected key=value, got ${p}`);
    }

    const v = p.slice(i + 1);

    try {
      out[p.slice(0, i)] = JSON.parse(v);
    } catch {
      out[p.slice(0, i)] = v;
    }
  }

  return out;
}

async function client(url: string): Promise<Client> {
  const agent = await agentKey();

  return connect(url, {
    key: agent?.seed,
    grants: [...loadGrants('grants'), ...loadGrants('consents')],
    name: o.name ?? 'yea-cli',
    budget: o.budget ? Number(o.budget) : undefined,
  });
}

const show = (r: { lens: string }) =>
  console.log(
    o.json ? JSON.stringify({ ...r, lens: undefined }, null, 2) : r.lens,
  );

/** A command that works locally (keys, grants, setup, servers). */
type Command = (rest: string[]) => Promise<void>;
/** A command that talks to the service at the first argument; `args` are the rest. */
type ServiceCommand = (c: Client, args: string[]) => Promise<void>;

const COMMANDS = new Map<string, Command>([
  ['init', cmdInit],
  ['whoami', cmdWhoami],
  ['grant', cmdGrant],
  ['grant-import', cmdGrantImport],
  ['delegate', cmdDelegate],
  ['inspect', cmdInspect],
  ['approve', cmdApprove],
  ['test-drive', cmdTestDrive],
  ['demo', cmdDemo],
  ['examples', cmdExamples],
  ['openapi', cmdOpenapi],
  ['mcp', cmdMcp],
  ['add', cmdAdd],
  ['remove', cmdRemove],
  ['services', cmdServices],
  ['setup', cmdInstall],
  ['install', cmdInstall],
  ['uninstall', cmdUninstall],
  ['doctor', cmdDoctor],
]);

const SERVICE_COMMANDS = new Map<string, ServiceCommand>([
  ['hello', cmdHello],
  ['ask', cmdAsk],
  ['intent', cmdIntent],
  ['commit', cmdCommit],
  ['undo', cmdUndo],
  ['expand', cmdExpand],
  [
    'do',
    (c, [capability, ...params]) => interactive(c, capability, kv(params)),
  ],
]);

async function main() {
  const [cmd, ...rest] = args;

  if (!cmd || o.help) {
    return console.log(HELP);
  }

  const command = COMMANDS.get(cmd);

  if (command) {
    return command(rest);
  }

  const [url, ...more] = rest;

  if (!url) {
    die(HELP);
  }

  const c = await client(url);

  try {
    const talk =
      SERVICE_COMMANDS.get(cmd) ?? die(`unknown command ${cmd}\n\n${HELP}`);

    await talk(c, more);
  } finally {
    c.close();
  }
}

const budgetFlag = () => (o.budget ? Number(o.budget) : undefined);

/** Where to install for AI tools: this project (--local) or the user's home. */
const installScope = () => ({ local: !!o.local, cwd: process.cwd() });

/** Ask a yes/no question on the terminal; only an answer starting with y counts as yes. */
async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const yes = /^y/i.test(await rl.question(question));

  rl.close();

  return yes;
}

/** Principals whose grants a local service trusts: YEA_TRUST, else the principal key here. */
async function trustedPrincipals(): Promise<string[]> {
  const trust = (process.env.YEA_TRUST ?? '').split(',').filter(Boolean);
  const p = await principalKey();

  if (p && !trust.length) {
    trust.push(p.public);
  }

  return trust;
}

/** A proposal's Lens without the header line. */
const proposalLens = (d: Proposal) =>
  lens({ yea: 1, id: '-', re: '-', kind: 'PROPOSALS', proposals: [d] })
    .split('\n')
    .slice(1)
    .join('\n');

// ---- identity ----

async function cmdInit() {
  const p = await principalKey(true),
    a = await agentKey(true);

  console.log(
    `principal ${p.public}\nagent     ${a.public}\n\nnext: yea grant --exp 24h --total spend=100.00USD --risk low`,
  );
}

async function cmdWhoami() {
  const p = await principalKey(),
    a = await agentKey();

  console.log(
    `principal ${p?.public ?? '(none — run yea init)'}\nagent     ${a?.public ?? '(none)'}`,
  );
}

async function cmdGrant() {
  const p = (await principalKey()) ?? die('no principal key — run yea init');
  const to = o.to ?? (await agentKey())?.public ?? die('no agent key');
  const token = await issueGrant({ principal: p, to, caveats: caveats() });
  const info = await inspectGrant(token);

  if (!o.to) {
    saveGrant(token, 'grants', info.id.slice(0, 16));
  }

  console.log(token);
  console.error(
    `\ngrant ${info.id.slice(0, 16)} → ${to}\n${lean({ caveats: info.blocks[0].caveats })}${o.to ? '' : `\nsaved to ${home()}/grants`}`,
  );
}

async function cmdGrantImport(rest: string[]) {
  const token = rest[0] ?? die('usage: yea grant-import <pg1.… token>');
  const info = await inspectGrant(token);
  const a = await agentKey();

  if (!a || info.holder !== a.public) {
    die(
      `this grant is for ${info.holder}, not this machine's agent key ${a?.public ?? '(none: run yea install)'}`,
    );
  }

  saveGrant(token, 'grants', info.id.slice(0, 16));
  console.log(`✓ imported grant ${info.id.slice(0, 16)} from ${info.iss}`);
}

async function cmdDelegate(rest: string[]) {
  const a = (await agentKey()) ?? die('no agent key');

  console.log(
    await delegateGrant(
      rest[0] ?? die('usage: yea delegate <token> --to <key>'),
      {
        holder: a,
        to: o.to ?? die('--to required'),
        caveats: caveats(),
      },
    ),
  );
}

async function cmdInspect(rest: string[]) {
  const info = await inspectGrant(rest[0] ?? die('usage: yea inspect <token>'));

  console.log(
    lean({
      id: info.id,
      principal: info.iss,
      holder: info.holder,
      chain: info.blocks.map((b) => ({
        to: b.sub,
        issued: fmtTime(b.iat),
        caveats: b.caveats.map((c) => JSON.stringify(c)),
      })),
    }),
  );
}

async function cmdApprove(rest: string[]) {
  const p =
    (await principalKey()) ??
    die('no principal key here: approve on the machine that holds it');
  const code = rest[0] ?? die('usage: yea approve <pc1.… code>');
  const consent = decodeConsentCode(code);

  if (consent.principal !== p.public) {
    die(`this consent is for principal ${consent.principal}, not ${p.public}`);
  }

  if (isJobCode(code)) {
    return approveJob(p, code);
  }

  const agent = o.to ?? (await agentKey())?.public ?? die('no agent key');

  await showConsent(consent);
  console.log(`  approval expires: ${fmtTime(consent.expires)}`);

  if (!process.stdin.isTTY) {
    die('✗ approval needs an interactive terminal: a human has to confirm');
  }

  if (!(await confirm('\napprove this exact action? [y/N] › '))) {
    die('not approved');
  }

  saveGrant(
    await consentGrant({ principal: p, agent, consent }),
    'consents',
    consent.hash,
  );
  console.log(
    '✓ approved: a one-time consent for this proposal only. The agent can commit now.',
  );
}

/**
 * Text from a consent code is untrusted: control characters (C0, C1, DEL) and bidi overrides
 * could rewrite what the person reads before signing, so they're shown as escapes.
 */
/** C0 (except tab and newline), DEL, C1, and the bidi marks and overrides. */
function unsafeChar(cp: number): boolean {
  return (
    (cp < 0x20 && cp !== 0x09 && cp !== 0x0a) ||
    (cp >= 0x7f && cp <= 0x9f) ||
    cp === 0x200e ||
    cp === 0x200f ||
    (cp >= 0x202a && cp <= 0x202e) ||
    (cp >= 0x2066 && cp <= 0x2069)
  );
}

const printable = (s: string) =>
  [...s]
    .map((c) => {
      const cp = c.codePointAt(0) ?? 0;

      return unsafeChar(cp) ? `\\u{${cp.toString(16)}}` : c;
    })
    .join('');

/** Whether a consent code carries a job (an MCP tool's plan) rather than a proposal. */
function isJobCode(code: string): boolean {
  try {
    const d = decodeConsentCode(code).detail as unknown as
      | { job?: unknown }
      | undefined;

    return d?.job !== undefined;
  } catch {
    return false;
  }
}

/**
 * Approve one job plan for an MCP server (SPEC-approval §6): re-check the plan hash, show the
 * plan, have the person type its phrase, and store a consent signed to the server's key.
 */
async function approveJob(p: KeyPair, code: string) {
  const now = Math.floor(Date.now() / 1000);
  let j: JobConsent;

  try {
    j = await readJobConsent(code, now);
  } catch (e) {
    die(`✗ ${(e as Error).message}: refusing`);
  }

  console.log(printable(`at server ${j.consent.service}, tool ${j.job.tool}:`));
  console.log(jobLines(j.job).map(printable).join('\n'));
  console.log(`  approval expires: ${fmtTime(j.consent.expires)}`);

  if (!process.stdin.isTTY) {
    die('✗ approval needs an interactive terminal: a human has to confirm');
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const typed = await rl.question(
    `\nto approve, type: ${printable(j.phrase)}\n› `,
  );

  rl.close();

  if (!phraseMatches(typed, j.phrase)) {
    die('not approved');
  }

  await jobStore().putConsent(j.planHash, await signJobConsent(p, j));
  console.log(
    '✓ approved: a one-time consent for this plan only. Ask the agent to call the tool again.',
  );
}

/** The store the MCP server reads consents from: YEA_STORE, else ~/.yea/store. */
const jobStore = () =>
  process.env.YEA_STORE
    ? new FileStore(process.env.YEA_STORE)
    : new FileStore();

/** The plan as the person reads it: summary, effects, then what it uses, risk and undo. */
function jobLines(job: JobConsent['job']): string[] {
  const uses =
    isUses(job.uses) && Object.keys(job.uses).length
      ? `uses: ${fmtUses(job.uses)} · `
      : '';
  const undo =
    typeof job.undoWindow === 'number' ? fmtDuration(job.undoWindow) : 'never';

  return [
    job.summary,
    ...job.effects.map((e) => `  ${effectLine(e)}`),
    `  ${uses}risk: ${String(job.risk)} · undo: ${undo}`,
    `  input: ${JSON.stringify(job.input)}`,
  ];
}

/** Print what a consent code asks for, refusing if its proposal details don't match its hash. */
async function showConsent(consent: ConsentRequest & { detail?: Proposal }) {
  const d = consent.detail;

  if (!d) {
    console.log(
      printable(
        `⚠ no proposal details in this code; only the service's summary:\n${consent.summary}\n  service: ${consent.service} · ${consent.capability} · proposal ${consent.proposal}`,
      ),
    );

    return;
  }

  if (
    d.id !== consent.proposal ||
    d.hash !== consent.hash ||
    d.capability !== consent.capability ||
    (d.uses !== undefined && !isUses(d.uses)) ||
    (await proposalHash(d)) !== consent.hash
  ) {
    die("✗ this consent code's proposal doesn't match its hash: refusing");
  }

  console.log(printable(`at ${consent.service}:\n${proposalLens(d)}`));
}

// ---- try it ----

async function cmdTestDrive(rest: string[]) {
  try {
    await import('@anthropic-ai/sdk');
  } catch {
    // Keep @yea-protocol/sdk dependency-free: fetch the SDK only for this command.
    const { spawnSync } = await import('node:child_process');
    const { createRequire } = await import('node:module');
    const version = createRequire(import.meta.url)('../package.json').version;

    console.error('fetching @anthropic-ai/sdk for the test drive…');

    const r = spawnSync(
      'npx',
      [
        '-y',
        '-p',
        '@anthropic-ai/sdk',
        '-p',
        `@yea-protocol/sdk@${version}`,
        'yea',
        ...process.argv.slice(2),
      ],
      { stdio: 'inherit' },
    );

    process.exit(r.status ?? 1);
  }

  const { testDrive } = await import('./testdrive.js');

  await testDrive({ model: o.model, prompt: rest.join(' ') || undefined });
  process.exit(0);
}

async function cmdDemo() {
  const { runDemo } = await import('./examples/demo.js');

  await runDemo();
  process.exit(0);
}

async function cmdExamples() {
  const { calendar, shop, billing } = await import('./examples/index.js');
  const { listen } = await import('./node.js');
  const trust = await trustedPrincipals();
  const port = Number(o.port ?? 7447);

  await listen(calendar({ trust }), { port, host: o.host });
  await listen(shop({ trust }), { port: port + 2, host: o.host });
  await listen(billing({ trust }), { port: port + 4, host: o.host });
  console.error(
    `✓ calendar yea://127.0.0.1:${port} · shop yea://127.0.0.1:${port + 2} · billing yea://127.0.0.1:${port + 4} · trusting ${trust.length} principal(s)${trust.length ? '' : ' (run yea init first to commit anything)'}\n  try: yea do yea://127.0.0.1:${port} calendar.reschedule event=Ana`,
  );
}

// ---- bridges ----

async function cmdOpenapi(rest: string[]) {
  const { fromOpenAPI, loadOpenAPI } = await import('./openapi.js');
  const { listen, serveHttp } = await import('./node.js');
  const { PRESETS, presetOptions } = await import('./presets.js');
  const preset = o.preset
    ? (PRESETS[o.preset] ??
      die(
        `unknown preset ${o.preset}; one of: ${Object.keys(PRESETS).join(', ')}`,
      ))
    : null;

  for (const e of preset?.env ?? []) {
    if (!process.env[e]) {
      console.error(
        `note: ${e} is not set; ${o.preset} will only do what works without it`,
      );
    }
  }

  const spec = await loadOpenAPI(
    preset?.spec ??
      rest[0] ??
      die(
        'usage: yea openapi <spec.json|url> [--base <url>]  (or --preset ' +
          Object.keys(PRESETS).join('|') +
          ')',
      ),
  );
  const headers = {
    ...(preset ? presetOptions(preset).headers : {}),
    ...headerFlags(),
  };
  const trust = await trustedPrincipals();
  const svc = fromOpenAPI(spec, {
    ...(preset ? presetOptions(preset) : {}),
    ...(o.base ? { baseUrl: o.base } : {}),
    ...(o.id ? { id: o.id } : {}),
    ...(o.prefix ? { prefix: o.prefix } : {}),
    headers,
    trust,
  });
  const port = Number(o.port ?? 7447);

  await listen(svc, { port, host: o.host });

  if (o.http) {
    await serveHttp(svc, { port: Number(o.http), host: o.host });
  }

  const count = (kind: string) =>
    svc.capabilities.filter((c) => c.kind === kind).length;

  console.error(
    `✓ ${svc.id}: ${svc.capabilities.length} capabilities (${count('ask')} ask, ${count('intent')} intent)\n  yea://127.0.0.1:${port}${o.http ? `  ·  http://127.0.0.1:${o.http}/yea` : ''}\n  trusting ${trust.length} principal(s) for writes\n  try: yea hello yea://127.0.0.1:${port}`,
  );
}

/** --header "K: V" flags as a header map. */
const headerFlags = () =>
  Object.fromEntries(
    (o.header ?? []).map((h) => [
      h.slice(0, h.indexOf(':')).trim(),
      h.slice(h.indexOf(':') + 1).trim(),
    ]),
  );

async function cmdMcp(rest: string[]) {
  // With no URLs, serve the services registered with `yea add` (~/.yea/services.json).
  const urls = rest.length ? rest : listServices();
  const clients = (
    await Promise.all(
      urls.map((u) =>
        client(u).catch((e) => {
          console.error(`yea mcp: ${u}: ${(e as Error).message}`);

          return null;
        }),
      ),
    )
  ).filter((c): c is Client => !!c);

  await runMcpBridge(clients);
  process.exit(0);
}

// ---- services for your AI tools ----

async function cmdAdd(rest: string[]) {
  const url = rest[0] ?? die('usage: yea add <url>');
  const c = await client(url);
  const b = await c.hello(400);

  c.close();

  if (b.kind !== 'BRIEF') {
    return die(b.lens);
  }

  addService(url);
  console.log(
    `✓ added ${b.service.name} (${b.service.id}) · ${b.capabilities.length} capabilities\n  restart your AI tool to pick it up`,
  );
}

async function cmdRemove(rest: string[]) {
  removeService(rest[0] ?? die('usage: yea remove <url>'));
  console.log(`✓ removed ${rest[0]}`);
}

async function cmdServices() {
  const s = listServices();

  console.log(s.length ? s.join('\n') : 'no services yet: yea add <url>');
}

async function cmdInstall() {
  const scope = installScope();
  const names = o.target
    ? o.target.split(',').map((t) => t.trim())
    : detectedClients();

  for (const n of names) {
    if (!CLIENTS[n]) {
      die(`unknown target ${n}; one of: ${Object.keys(CLIENTS).join(', ')}`);
    }
  }

  const a = (await agentKey()) ?? (await agentKey(true));

  console.log(`agent key   ${a.public} (${home()})`);

  const p = await installPrincipal(a);

  if (p && !loadGrants('grants').length) {
    await installDefaultPolicy(p, a);
  }

  if (!names.length) {
    console.log(
      `\nno AI tools detected. Pick some: yea install --target ${Object.keys(CLIENTS).join(',')}`,
    );
  }

  for (const n of names) {
    try {
      for (const line of CLIENTS[n].install(scope)) {
        console.log(`✓ ${CLIENTS[n].name}: ${line}`);
      }
    } catch (e) {
      console.log(`✗ ${CLIENTS[n].name}: ${(e as Error).message}`);
    }
  }

  const s = listServices();

  console.log(
    s.length
      ? `\nservices    ${s.join(', ')}`
      : '\nnext: add a service with `yea add <url>`, or try the examples: `yea examples`, then `yea add yea://127.0.0.1:7447`',
  );
  console.log(
    'restart your AI tool, then ask it to do something. Check anything with: yea doctor',
  );
}

/**
 * The principal (approval) key should live where agents can't read it. Only create it here
 * when asked: --with-principal, or a yes at the interactive prompt.
 */
async function installPrincipal(a: KeyPair): Promise<KeyPair | null> {
  const existing = await principalKey();

  if (existing) {
    console.log(`principal   ${existing.public}`);

    return existing;
  }

  let create = !!o['with-principal'];

  if (!create && process.stdin.isTTY && !o.yes) {
    create = await confirm(
      'Create your approval (principal) key on this machine too? Handy for trying YEA, but an agent with shell access could read it. [y/N] › ',
    );
  }

  if (!create) {
    console.log(
      `principal   not on this machine (recommended). On the device that holds it, run:\n              yea grant --to ${a.public} --risk low --each spend=25.00USD --total spend=100.00USD --exp 30d\n            and save the token here with: yea grant-import <token>   (or re-run with --with-principal to try things quickly)`,
    );

    return null;
  }

  const p = await principalKey(true);

  console.log(
    `principal   ${p.public} (on this machine: fine for trying things; see SECURITY.md for real use)`,
  );

  return p;
}

/** Grant the agent a safe default policy: low risk, ≤ 25 USD each, ≤ 100 USD total, 30 days. */
async function installDefaultPolicy(p: KeyPair, a: KeyPair) {
  const caveats: Caveat[] = [
    { risk: 'low' },
    { each: { of: 'spend', max: 2500, scale: 2, unit: 'USD' } },
    { total: { of: 'spend', max: 10000, scale: 2, unit: 'USD' } },
    { exp: Math.floor(Date.now() / 1000) + 30 * 86400 },
  ];
  const token = await issueGrant({ principal: p, to: a.public, caveats });

  saveGrant(token, 'grants', (await inspectGrant(token)).id.slice(0, 16));
  console.log(
    'policy      low-risk actions, ≤ 25.00 USD each, ≤ 100.00 USD total, 30 days. Anything else asks you. (change: yea grant …)',
  );
}

async function cmdUninstall() {
  const scope = installScope();
  const names = o.target
    ? o.target.split(',').map((t) => t.trim())
    : Object.keys(CLIENTS);
  let n = 0;

  for (const name of names) {
    try {
      for (const line of CLIENTS[name]?.uninstall(scope) ?? []) {
        console.log(`✓ ${CLIENTS[name].name}: ${line}`);
        n++;
      }
    } catch (e) {
      console.log(`✗ ${CLIENTS[name]?.name ?? name}: ${(e as Error).message}`);
    }
  }

  console.log(
    n
      ? `done. Keys and grants in ${home()} were left in place (delete that folder to remove them).`
      : 'nothing to remove.',
  );
}

// ---- doctor ----

const ok = (m: string) => console.log(`✓ ${m}`);
const warn = (m: string) => console.log(`! ${m}`);
const bad = (m: string) => console.log(`✗ ${m}`);

async function cmdDoctor() {
  const major = Number(process.versions.node.split('.')[0]);

  if (major >= 20) {
    ok(`node ${process.versions.node}`);
  } else {
    bad(`node ${process.versions.node}: YEA needs node ≥ 20`);
  }

  const a = await agentKey();

  if (a) {
    ok(`agent key ${a.public.slice(0, 24)}…`);
  } else {
    bad('no agent key: run yea install');
  }

  const p = await principalKey();

  if (p) {
    warn(
      `principal key is readable here (${process.env.YEA_PRINCIPAL_HOME ?? home()}). Fine for trying things; for real use keep it away from agents (SECURITY.md)`,
    );
  } else {
    ok('principal key is not on this machine (recommended)');
  }

  await checkGrants(a);
  await checkServices();
  checkRegistration();
}

async function checkGrants(a: KeyPair | null) {
  const grants = loadGrants('grants');

  if (!grants.length) {
    bad(
      'no grants: your agent can read but not act. yea grant … (or yea install)',
    );
  }

  for (const g of grants) {
    try {
      checkGrant(await inspectGrant(g), a);
    } catch {
      bad('a saved grant is unreadable');
    }
  }
}

function checkGrant(info: GrantInfo, a: KeyPair | null) {
  const now = Math.floor(Date.now() / 1000);
  const cav = info.blocks.flatMap((b) => b.caveats);
  const exp = Math.min(
    ...cav.flatMap((c) => ('exp' in c && c.exp ? [c.exp] : [])),
    Infinity,
  );
  const scope =
    cav
      .find((c): c is { svc: string[] } => 'svc' in c && !!c.svc)
      ?.svc.join(', ') ?? 'all services';
  const holder = a && info.holder === a.public ? '' : ' (held by another key!)';

  if (exp !== Infinity && exp <= now) {
    bad(`grant ${info.id.slice(0, 10)} expired ${fmtTime(exp)}${holder}`);
  } else {
    ok(
      `grant ${info.id.slice(0, 10)}: ${scope}; ${exp === Infinity ? 'no expiry' : `expires ${fmtTime(exp)}`}${holder}`,
    );
  }
}

async function checkServices() {
  const services = listServices();

  if (!services.length) {
    warn('no services: yea add <url>');
  }

  for (const u of services) {
    const t0 = Date.now();

    try {
      const c = await client(u);
      const b = await c.hello(200);

      c.close();

      if (b.kind === 'BRIEF') {
        ok(`${u}: ${b.service.name} (${Date.now() - t0} ms)`);
      } else {
        bad(`${u}: ${b.lens}`);
      }
    } catch (e) {
      bad(`${u}: ${(e as Error).message}`);
    }
  }
}

function checkRegistration() {
  const scope = installScope();
  const installed = Object.values(CLIENTS)
    .filter((t) => {
      try {
        return t.installed(scope);
      } catch {
        return false;
      }
    })
    .map((t) => t.name);

  if (installed.length) {
    ok(`registered with: ${installed.join(', ')}`);
  } else {
    warn('not registered with any AI tool: yea install');
  }
}

// ---- talk to a service ----

async function cmdHello(c: Client) {
  show(await c.hello(budgetFlag()));
}

async function cmdAsk(c: Client, [capability, ...params]: string[]) {
  show(await c.ask(capability, kv(params), { budget: budgetFlag() }));
}

async function cmdIntent(c: Client, [capability, ...params]: string[]) {
  show(
    await c.intent(capability, kv(params), {
      goal: o.goal,
      budget: budgetFlag(),
    }),
  );
}

async function cmdCommit(c: Client, [id, hash]: string[]) {
  show(await c.commit({ id, hash }, { onEvent: (e) => console.error(e.lens) }));
}

async function cmdUndo(c: Client, [receipt]: string[]) {
  show(await c.undo(receipt, { onEvent: (e) => console.error(e.lens) }));
}

async function cmdExpand(c: Client, [handle]: string[]) {
  show(await c.expand(handle, { budget: budgetFlag() }));
}

/** `yea do`: intent → choose → commit, answering questions and consent prompts at the terminal. */
async function interactive(
  c: Client,
  capability: string,
  params: Record<string, unknown>,
) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    for (;;) {
      const r = await c.intent(capability, params, { goal: o.goal });

      console.log(r.lens);

      if (r.kind === 'CLARIFY') {
        const n = Number(await rl.question('\nchoose › ')) - 1;

        Object.assign(params, r.options[n]?.params ?? die('no such option'));

        continue;
      }

      if (r.kind !== 'PROPOSALS') {
        return;
      }

      const chosen = await chooseProposal(rl, r.proposals);

      if (!chosen) {
        return;
      }

      let res = await c.commit(chosen, { onEvent: (e) => console.log(e.lens) });

      if (res.kind === 'ERROR' && res.code === 'consent_required') {
        console.log(res.lens);
        res =
          (await consentAndRetry({ c, rl, chosen, consent: res.consent })) ??
          res;
      }

      console.log(res.lens);

      return;
    }
  } finally {
    rl.close();
  }
}

/** Pick the proposal to commit: confirm a lone one, or choose by number. Null means stop. */
async function chooseProposal(
  rl: Interface,
  proposals: Proposal[],
): Promise<Proposal | null> {
  const pick =
    proposals.length === 1
      ? proposals[0]
      : (proposals.find((p) => p.id === '') ?? null);

  if (pick) {
    return /^y/i.test(await rl.question('\ncommit? [y/N] › ')) ? pick : null;
  }

  const ans = await rl.question(
    `\ncommit which? [1-${proposals.length}, blank to stop] › `,
  );

  if (!ans.trim()) {
    return null;
  }

  return proposals[Number(ans) - 1] ?? die('no such proposal');
}

/**
 * The service wants the principal's consent. If the principal key is here, show the proposal,
 * and on a yes sign a one-time consent and commit again. Returns the new reply, or null.
 */
async function consentAndRetry({
  c,
  rl,
  chosen,
  consent: k,
}: {
  c: Client;
  rl: Interface;
  chosen: Proposal;
  consent: ConsentRequest | undefined;
}) {
  const p = await principalKey();

  if (
    !k ||
    k.proposal !== chosen.id ||
    k.hash !== chosen.hash ||
    k.capability !== chosen.capability ||
    k.service !== (await c.audience())
  ) {
    die(
      "✗ the service's consent request doesn't match the proposal shown; not signing",
    );
  }

  if (!p || p.public !== k.principal) {
    return null;
  }

  console.log(
    `\n  ${chosen.summary}\n${chosen.effects.map((e) => `    ${effectLine(e)}`).join('\n')}`,
  );

  if (
    !/^y/i.test(
      await rl.question('\n[principal] approve this exact proposal? [y/N] › '),
    )
  ) {
    return null;
  }

  const a = (await agentKey()) ?? die('no agent key');
  const token = await consentGrant({
    principal: p,
    agent: a.public,
    consent: { ...k, expires: Math.min(k.expires, chosen.expires) },
  });

  return c.commit(chosen, {
    grants: [token],
    onEvent: (e) => console.log(e.lens),
  });
}

main().catch((e) => die(`✗ ${(e as Error).message}`));
