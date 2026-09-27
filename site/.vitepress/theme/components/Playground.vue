<script setup lang="ts">
// The YEA playground: the real protocol core and example services, running in the page.
// You play the agent (left); the right shows exactly what a model would read.
import { computed, nextTick, onMounted, reactive, ref, shallowRef, watch } from "vue";
import type { Client, KeyPair } from "@yea-protocol/sdk";

type Core = typeof import("@yea-protocol/sdk");
type Frame = Record<string, any>;
type Exchange = { n: number; service: string; request: Frame; reply: Frame; events: Frame[]; ms: number; auto: boolean };

const core = shallowRef<Core | null>(null);
const failed = ref("");
const keys = shallowRef<{ principal: KeyPair; agent: KeyPair } | null>(null);
const services = shallowRef<Record<string, any>>({});
const clients = shallowRef<Record<string, Client>>({});
const grant = ref("");
const grantInfo = ref<any>(null);

const SERVICES = { calendar: "calendar.example", shop: "shop.example", billing: "billing.example" } as const;
type Svc = keyof typeof SERVICES;
const VERBS = ["HELLO", "ASK", "INTENT", "COMMIT", "UNDO", "EXPAND"] as const;

const day = (n: number) => new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()) + (n + 1) * 864e5).toISOString().slice(0, 10);
const EXAMPLES: Record<string, object> = {
  "calendar.agenda": { query: "Ana" },
  "calendar.free": { day: day(2) },
  "calendar.reschedule": { event: "1:1 with Ana", day: day(2) },
  "calendar.cancel": { event: "Standup" },
  "calendar.book": { title: "Coffee with Sam", with: ["sam@example.com"], day: day(1) },
  "shop.search": { tag: "vegan", max_cal: 700 },
  "shop.order": { items: [{ sku: "m047", qty: 2 }, { sku: "m055", qty: 2 }], deliver: day(1) },
  "shop.tip": { order: "o1001", usd: 5 },
  "billing.customers": { status: "active" },
  "billing.customer": { who: "Chen" },
  "billing.refund": { who: "Chen" },
  "billing.change_plan": { who: "Dana", plan: "pro" },
  "billing.cancel": { who: "Ben" },
};

const form = reactive({
  service: "calendar" as Svc,
  verb: "INTENT" as (typeof VERBS)[number],
  capability: "calendar.reschedule",
  params: JSON.stringify(EXAMPLES["calendar.reschedule"], null, 2),
  goal: "",
  auto: true,
  useBudget: false,
  budget: 600,
  target: "",
});
const policy = reactive({ calendar: true, shop: true, billing: true, risk: "low", each: "40", total: "100", exp: "8h" });

const log = ref<Exchange[]>([]);
const selected = ref<number | null>(null);
const tab = ref<"lens" | "json">("lens");
const busy = ref(false);
const paramsError = ref("");
let n = 0;

// Things the agent has seen, so COMMIT/UNDO/EXPAND can pick from them.
const seen = reactive({ proposals: [] as (Frame & { service: Svc })[], receipts: [] as (Frame & { service: Svc })[], handles: [] as (Frame & { service: Svc })[] });

const current = computed(() => log.value.find((x) => x.n === selected.value) ?? log.value[log.value.length - 1] ?? null);
const caps = computed(() => {
  const svc = services.value[form.service];
  if (!svc) return [];
  return svc.capabilities.filter((c: any) => (form.verb === "ASK" ? c.kind === "ask" : c.kind === "intent"));
});
const targets = computed(() => {
  const list = form.verb === "COMMIT" ? seen.proposals : form.verb === "UNDO" ? seen.receipts : form.verb === "EXPAND" ? seen.handles : [];
  return list.filter((x) => x.service === form.service);
});

onMounted(async () => {
  try {
    const [c, cal, sh, bi] = await Promise.all([import("@yea-protocol/sdk"), import("@examples/calendar.ts"), import("@examples/shop.ts"), import("@examples/billing.ts")]);
    core.value = c;
    const [principal, agent] = await Promise.all([c.keyPair(), c.keyPair()]);
    keys.value = { principal, agent };
    services.value = { calendar: cal.calendar({ trust: [principal.public] }), shop: sh.shop({ trust: [principal.public] }), billing: bi.billing({ trust: [principal.public] }) };
    await rebuildGrant();
    await nextTick();
    await send(); // open on a real exchange
  } catch (e: any) {
    failed.value = e?.message ?? String(e);
  }
});

// ---- the human's policy → a real signed grant ----

function caveats() {
  const out: any[] = [];
  const svc = (Object.keys(SERVICES) as Svc[]).filter((s) => policy[s]).map((s) => SERVICES[s]);
  out.push({ svc });
  if (policy.risk) out.push({ risk: policy.risk });
  const usd = (s: string) => ({ of: "spend", max: Math.round(Number(s) * 100), scale: 2, unit: "USD" });
  if (policy.each !== "" && Number(policy.each) >= 0) out.push({ each: usd(policy.each) });
  if (policy.total !== "" && Number(policy.total) >= 0) out.push({ total: usd(policy.total) });
  const m = /^(\d+)([mhd])$/.exec(policy.exp);
  if (m) out.push({ exp: Math.floor(Date.now() / 1000) + Number(m[1]) * { m: 60, h: 3600, d: 86400 }[m[2] as "m"] });
  return out;
}

async function rebuildGrant() {
  const c = core.value!, k = keys.value!;
  grant.value = await c.issueGrant({ principal: k.principal, to: k.agent.public, caveats: caveats() });
  grantInfo.value = await c.inspectGrant(grant.value);
  const next: Record<string, Client> = {};
  for (const s of Object.keys(SERVICES) as Svc[]) next[s] = new c.Client(capture(s), { key: k.agent.seed, grants: [grant.value], name: "playground" });
  clients.value = next;
}
let rebuild: ReturnType<typeof setTimeout> | undefined;
watch(policy, () => {
  if (!core.value) return;
  clearTimeout(rebuild);
  rebuild = setTimeout(rebuildGrant, 250);
});

// ---- transport that records every frame ----

let autoFlag = false;
function capture(service: Svc) {
  return {
    async request(frame: Frame, onEvent?: (e: any) => void) {
      const events: Frame[] = [];
      const t0 = performance.now();
      const reply = await services.value[service].handle(JSON.parse(JSON.stringify(frame)), (e: Frame) => {
        events.push(e);
        onEvent?.(e);
      });
      const x: Exchange = { n: ++n, service, request: frame, reply, events, ms: performance.now() - t0, auto: autoFlag && frame.verb !== "HELLO" };
      log.value = [...log.value, x];
      remember(service, reply);
      return reply;
    },
    close() {},
  } as any;
}

function remember(service: Svc, r: Frame) {
  if (r.kind === "PROPOSALS") for (const p of r.proposals) seen.proposals.unshift({ ...p, service });
  if (r.kind === "RECEIPT" && !r.replay) {
    if (!r.receipt.undoes) seen.receipts.unshift({ ...r.receipt, service });
    if (r.auto) seen.proposals.unshift({ id: r.receipt.proposal, summary: r.receipt.summary, hash: "", service, committed: true });
  }
  for (const m of r.more ?? []) seen.handles.unshift({ ...m, service });
}

// ---- composing and sending ----

watch(() => form.service, () => {
  const first = caps.value[0]?.name;
  if (first) pickCapability(first);
});
watch(() => form.verb, () => {
  if ((form.verb === "ASK" || form.verb === "INTENT") && !caps.value.some((c: any) => c.name === form.capability)) {
    if (caps.value[0]) pickCapability(caps.value[0].name);
  }
  form.target = targets.value[0]?.id ?? targets.value[0]?.handle ?? "";
});
watch(targets, (t) => {
  if (!t.some((x) => (x.id ?? x.handle) === form.target)) form.target = t[0]?.id ?? t[0]?.handle ?? "";
});

function pickCapability(name: string) {
  form.capability = name;
  form.params = JSON.stringify(EXAMPLES[name] ?? {}, null, 2);
}

function parsedParams(): object | null {
  try {
    const v = JSON.parse(form.params || "{}");
    if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error("params must be a JSON object");
    paramsError.value = "";
    return v;
  } catch (e: any) {
    paramsError.value = e.message;
    return null;
  }
}

async function send(extraGrants?: string[]) {
  const c = clients.value[form.service];
  if (!c || busy.value) return;
  const budget = form.useBudget ? form.budget : undefined;
  busy.value = true;
  selected.value = null;
  autoFlag = form.verb === "INTENT" && form.auto;
  try {
    if (form.verb === "HELLO") await c.hello(budget);
    else if (form.verb === "ASK" || form.verb === "INTENT") {
      const p = parsedParams();
      if (!p) return;
      if (form.verb === "ASK") await c.ask(form.capability, p as any, { budget });
      else await c.intent(form.capability, p as any, { budget, auto: form.auto, goal: form.goal || undefined });
    } else if (form.verb === "COMMIT") {
      const p = seen.proposals.find((x) => x.id === form.target);
      if (p) await c.commit({ id: p.id, hash: p.hash }, { budget, grants: extraGrants });
    } else if (form.verb === "UNDO") {
      if (form.target) await c.undo(form.target);
    } else if (form.verb === "EXPAND") {
      if (form.target) await c.expand(form.target, { budget });
    }
  } finally {
    busy.value = false;
    autoFlag = false;
  }
}

// Quick actions on the current reply.
async function act(verb: "COMMIT" | "UNDO" | "EXPAND", target: string, service = current.value!.service as Svc) {
  form.service = service;
  await nextTick();
  form.verb = verb;
  await nextTick();
  form.target = target;
  await send();
}
async function choose(option: { params: object }) {
  const req = current.value!.request;
  form.service = current.value!.service as Svc;
  await nextTick();
  form.verb = "INTENT";
  form.capability = req.capability;
  form.params = JSON.stringify({ ...(req.params ?? {}), ...option.params }, null, 2);
  await send();
}

function preset(kind: string) {
  const set = (service: Svc, verb: (typeof VERBS)[number], cap: string, params: object, o: Partial<typeof form> = {}, then?: () => Promise<void>) => {
    form.service = service;
    nextTick(() => {
      form.verb = verb;
      form.capability = cap;
      form.params = JSON.stringify(params, null, 2);
      Object.assign(form, { auto: false, useBudget: false }, o);
      nextTick(async () => {
        await send();
        await then?.();
      });
    });
  };
  if (kind === "auto") set("calendar", "INTENT", "calendar.reschedule", EXAMPLES["calendar.reschedule"], { auto: true });
  if (kind === "clarify") set("calendar", "INTENT", "calendar.reschedule", { event: "Ana", day: day(2) });
  // Over the per-action limit, so auto falls back to proposals; committing one then asks the human.
  if (kind === "consent")
    set("shop", "INTENT", "shop.order", EXAMPLES["shop.order"], { auto: true }, async () => {
      const r = current.value?.reply;
      if (r?.kind === "PROPOSALS") await act("COMMIT", r.proposals[0].id, "shop");
    });
  // A refund can't be undone, so it's never auto-committed, and it's above the policy's risk.
  if (kind === "refund")
    set("billing", "INTENT", "billing.refund", EXAMPLES["billing.refund"], { auto: true }, async () => {
      const r = current.value?.reply;
      if (r?.kind === "PROPOSALS") await act("COMMIT", r.proposals[r.proposals.length - 1].id, "billing");
    });
  if (kind === "budget") set("shop", "ASK", "shop.search", {}, { useBudget: true, budget: 250 });
  if (kind === "typo") set("calendar", "ASK", "calendar.agenda", { dya: day(0) });
}

// ---- consent: the human approves exactly what they're shown ----

const consent = computed(() => (current.value?.reply.code === "consent_required" ? current.value.reply.consent : null));
const consentProposal = computed(() => (consent.value ? seen.proposals.find((p) => p.id === consent.value.proposal && p.hash === consent.value.hash) : null));
const consentCheck = ref<"checking" | "ok" | "mismatch">("checking");
watch(consent, async (c) => {
  consentCheck.value = "checking";
  const p = consentProposal.value;
  if (!c || !p || !core.value) return (consentCheck.value = "mismatch");
  const { service: _s, committed: _c, ...proposal } = p;
  const ok = c.service === SERVICES[current.value!.service as Svc] && c.capability === p.capability && (await core.value.proposalHash(proposal)) === c.hash;
  consentCheck.value = ok ? "ok" : "mismatch";
});

async function approve() {
  const c = consent.value, k = keys.value!;
  if (!c || consentCheck.value !== "ok") return;
  const token = await core.value!.consentGrant({ principal: k.principal, agent: k.agent.public, consent: c });
  form.service = current.value!.service as Svc;
  await nextTick();
  form.verb = "COMMIT";
  await nextTick();
  form.target = c.proposal;
  await send([token]);
}

// ---- rendering ----

const lensText = computed(() => (current.value ? current.value.reply.lens ?? core.value?.lens(current.value.reply as any) ?? "" : ""));
const eventLens = computed(() => (current.value && core.value ? current.value.events.map((e) => core.value!.lens(e as any)) : []));
const tokens = computed(() => {
  if (!current.value || !core.value) return null;
  const { est } = core.value;
  return { lens: est(lensText.value), json: est(JSON.stringify(current.value.reply)), pretty: est(JSON.stringify(current.value.reply, null, 2)) };
});
const state = (r: Frame) =>
  r.kind === "RECEIPT" ? "green" : r.kind === "ERROR" ? (r.code === "consent_required" ? "amber" : "red") : r.kind === "PROPOSALS" || r.kind === "CLARIFY" ? "amber" : "plain";

function lineClass(l: string) {
  if (l.startsWith("✓")) return "green";
  if (l.startsWith("✗")) return current.value?.reply.code === "consent_required" ? "amber" : "red";
  if (l.startsWith("? ") || /^\d+ proposals?/.test(l) || /^\[p_/.test(l)) return "amber";
  if (l.startsWith("… ") && l.includes(" more at ")) return "more";
  if (/^ {2}[~+\-$>*] /.test(l)) return "effect";
  return "";
}
const reqSummary = (x: Exchange) => {
  const r = x.request;
  return r.verb === "ASK" || r.verb === "INTENT" ? `${r.verb} ${r.capability}` : r.verb === "COMMIT" ? `COMMIT ${r.proposal}` : r.verb === "UNDO" ? `UNDO ${r.receipt}` : r.verb === "EXPAND" ? `EXPAND ${r.handle}` : r.verb;
};
const replySummary = (r: Frame) => (r.kind === "ERROR" ? r.code : r.kind === "RECEIPT" ? (r.replay ? "RECEIPT (replay)" : r.auto ? "RECEIPT (auto)" : r.receipt.undoes ? "RECEIPT (undo)" : "RECEIPT") : r.kind);
const pretty = (v: unknown) => JSON.stringify(v, null, 2);
/** The consent card's facts: what the proposal uses (if anything), its risk and its undo window. */
const consentMeta = computed(() => {
  const p = consentProposal.value, c = core.value;
  if (!p || !c) return "";
  const uses: Record<string, Parameters<Core["fmtQuantity"]>[0]> = p.uses ?? {};
  const used = Object.keys(uses).sort().map((n) => `${n} ${c.fmtQuantity(uses[n])}`);
  const parts = [
    ...(used.length ? [`uses ${used.join(", ")}`] : []),
    `risk ${p.risk}`,
    p.undo ? `undo for ${c.fmtDuration(p.undo.window)}` : "irreversible",
  ];
  const text = parts.join(", ");
  return text[0].toUpperCase() + text.slice(1);
});

const shortGrant = computed(() => (grant.value ? grant.value.slice(0, 28) + "…" + grant.value.slice(-8) : ""));
const copied = ref(false);
async function copyLens() {
  await navigator.clipboard.writeText(lensText.value);
  copied.value = true;
  setTimeout(() => (copied.value = false), 1200);
}
function onKey(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") send();
}
</script>

<template>
  <div class="pg" @keydown="onKey">
    <header class="pg-head">
      <div>
        <h1>Playground</h1>
        <p>
          You're the agent. A calendar, a meal shop and a billing system run in this page on the real YEA core, and your requests are
          signed with a grant from the human's policy. The right side shows exactly what a model would read.
        </p>
      </div>
      <div class="presets" role="group" aria-label="Try a scenario">
        <button type="button" @click="preset('auto')">Move a meeting in one round trip</button>
        <button type="button" @click="preset('clarify')">Ambiguous request</button>
        <button type="button" @click="preset('consent')">Order over the limit</button>
        <button type="button" @click="preset('refund')">A refund that can't be undone</button>
        <button type="button" @click="preset('budget')">60 items in 250 tokens</button>
        <button type="button" @click="preset('typo')">A typo that teaches</button>
      </div>
    </header>

    <p v-if="failed" class="fatal">The playground couldn't start: {{ failed }}. It needs a browser with Ed25519 in WebCrypto (current Chrome, Firefox or Safari).</p>
    <p v-else-if="!core" class="loading">Starting the services…</p>

    <div v-else class="grid">
      <!-- left: the agent -->
      <section class="pane agent" aria-label="Your request">
        <div class="seg" role="tablist" aria-label="Service">
          <button v-for="(id, s) in SERVICES" :key="s" type="button" role="tab" :aria-selected="form.service === s" :class="{ on: form.service === s }" @click="form.service = s">{{ id }}</button>
        </div>

        <div class="verbs" role="tablist" aria-label="Verb">
          <button v-for="v in VERBS" :key="v" type="button" role="tab" :aria-selected="form.verb === v" :class="{ on: form.verb === v }" @click="form.verb = v">{{ v }}</button>
        </div>

        <template v-if="form.verb === 'ASK' || form.verb === 'INTENT'">
          <label class="field">
            <span>Capability</span>
            <select :value="form.capability" @change="pickCapability(($event.target as HTMLSelectElement).value)">
              <option v-for="c in caps" :key="c.name" :value="c.name">{{ c.name }}</option>
            </select>
          </label>
          <p class="hint">{{ caps.find((c: any) => c.name === form.capability)?.summary }}</p>
          <label class="field">
            <span>Params</span>
            <textarea v-model="form.params" spellcheck="false" rows="7" :aria-invalid="!!paramsError" @blur="parsedParams()" />
          </label>
          <p v-if="paramsError" class="err">{{ paramsError }}</p>
          <label v-if="form.verb === 'INTENT'" class="field">
            <span>Goal <em>optional</em></span>
            <input v-model="form.goal" placeholder="push my 1:1 with Ana to later this week" />
          </label>
          <label v-if="form.verb === 'INTENT'" class="toggle">
            <input v-model="form.auto" type="checkbox" />
            <span>auto: commit now if the policy allows it and it can be undone</span>
          </label>
        </template>

        <template v-else-if="form.verb !== 'HELLO'">
          <label class="field">
            <span>{{ form.verb === "COMMIT" ? "Proposal" : form.verb === "UNDO" ? "Receipt" : "Handle" }}</span>
            <select v-model="form.target" :disabled="!targets.length">
              <option v-for="t in targets" :key="t.id ?? t.handle" :value="t.id ?? t.handle" :disabled="t.committed">
                {{ t.id ?? t.handle }} · {{ t.summary ?? `${t.remaining} more at ${t.path}` }}{{ t.committed ? " (auto-committed)" : "" }}
              </option>
            </select>
          </label>
          <p v-if="!targets.length" class="hint">
            {{ form.verb === "COMMIT" ? "Send an INTENT first to get proposals." : form.verb === "UNDO" ? "Commit something first to get a receipt." : "Ask with a small budget to get a handle." }}
          </p>
        </template>
        <p v-else class="hint">Discover what {{ SERVICES[form.service] }} can do.</p>

        <label class="toggle">
          <input v-model="form.useBudget" type="checkbox" />
          <span>Token budget</span>
        </label>
        <div v-if="form.useBudget" class="budget">
          <input v-model.number="form.budget" type="range" min="60" max="3000" step="10" aria-label="Token budget" />
          <output>{{ form.budget }}</output>
        </div>

        <button class="send" type="button" :disabled="busy" @click="send()">
          Send {{ form.verb }}<kbd>⌘↵</kbd>
        </button>

        <details class="policy" open>
          <summary>The human's policy</summary>
          <p class="hint">Signed by the human's key and presented with every request. Change it and the grant is re-signed.</p>
          <div class="checks">
            <label><input v-model="policy.calendar" type="checkbox" /> calendar.example</label>
            <label><input v-model="policy.shop" type="checkbox" /> shop.example</label>
            <label><input v-model="policy.billing" type="checkbox" /> billing.example</label>
          </div>
          <div class="row3">
            <label class="field"><span>Risk up to</span>
              <select v-model="policy.risk"><option value="low">low</option><option value="medium">medium</option><option value="high">high</option></select>
            </label>
            <label class="field"><span>Per action, USD</span><input v-model="policy.each" inputmode="decimal" /></label>
            <label class="field"><span>Total, USD</span><input v-model="policy.total" inputmode="decimal" /></label>
          </div>
          <label class="field"><span>Expires in</span>
            <select v-model="policy.exp"><option value="15m">15 minutes</option><option value="8h">8 hours</option><option value="7d">7 days</option></select>
          </label>
          <div class="grant">
            <code :title="grant">{{ shortGrant }}</code>
            <pre>{{ grantInfo ? grantInfo.blocks[0].caveats.map((c: any) => JSON.stringify(c)).join("\n") : "" }}</pre>
          </div>
        </details>
      </section>

      <!-- right: what the model reads -->
      <section class="pane out" aria-label="What the model reads" aria-live="polite">
        <template v-if="current">
          <div class="out-head">
            <span :class="['badge', state(current.reply)]">{{ replySummary(current.reply) }}</span>
            <span class="req">{{ reqSummary(current) }}</span>
            <span v-if="tokens" class="tok" title="Shared token estimate (SPEC §8)">
              Lens {{ tokens.lens }} · JSON {{ tokens.json }} · pretty JSON {{ tokens.pretty }} tokens
            </span>
          </div>
          <div class="tabs" role="tablist">
            <button type="button" role="tab" :aria-selected="tab === 'lens'" :class="{ on: tab === 'lens' }" @click="tab = 'lens'">Lens</button>
            <button type="button" role="tab" :aria-selected="tab === 'json'" :class="{ on: tab === 'json' }" @click="tab = 'json'">Frames</button>
            <button v-if="tab === 'lens'" type="button" class="copy" @click="copyLens">{{ copied ? "Copied" : "Copy" }}</button>
          </div>

          <div v-if="tab === 'lens'" class="lens">
            <div v-for="(e, i) in eventLens" :key="'e' + i" class="ln event">{{ e }}</div>
            <div v-for="(l, i) in lensText.split('\n')" :key="i" :class="['ln', lineClass(l)]">{{ l }}</div>
          </div>
          <div v-else class="frames">
            <h3>Request</h3>
            <pre>{{ pretty(current.request) }}</pre>
            <template v-if="current.events.length">
              <h3>Events</h3>
              <pre v-for="(e, i) in current.events" :key="i">{{ pretty(e) }}</pre>
            </template>
            <h3>Reply</h3>
            <pre>{{ pretty(current.reply) }}</pre>
          </div>

          <!-- act on the reply -->
          <div v-if="consent" class="consent" role="region" aria-label="Approval needed">
            <h3>Your agent needs your approval</h3>
            <p>{{ current.reply.message }}</p>
            <template v-if="consentProposal && consentCheck === 'ok'">
              <p class="what">{{ consentProposal.summary }}</p>
              <ul>
                <li v-for="(e, i) in consentProposal.effects" :key="i"><code>{{ core!.effectLine(e) }}</code></li>
              </ul>
              <p class="meta">{{ consentMeta }}. Hash checked against the proposal the agent received.</p>
              <div class="actions">
                <button type="button" class="approve" @click="approve">Approve as human and commit</button>
              </div>
              <p class="fine">Signs a one-time grant: COMMIT of this proposal hash, at {{ consent.service }}, until it expires. Nothing else.</p>
            </template>
            <p v-else-if="consentCheck === 'mismatch'" class="err">This consent request doesn't match a proposal the agent received, so it can't be approved here.</p>
          </div>

          <div v-else class="quick">
            <template v-if="current.reply.kind === 'PROPOSALS'">
              <button v-for="p in current.reply.proposals" :key="p.id" type="button" @click="act('COMMIT', p.id)">Commit {{ p.id }}</button>
            </template>
            <template v-if="current.reply.kind === 'CLARIFY'">
              <button v-for="o in current.reply.options" :key="o.label" type="button" @click="choose(o)">{{ o.label }}</button>
            </template>
            <button v-if="current.reply.kind === 'RECEIPT' && !current.reply.receipt.undoes && current.reply.receipt.undo" type="button" @click="act('UNDO', current.reply.receipt.id)">Undo {{ current.reply.receipt.id }}</button>
            <button v-for="m in current.reply.more ?? []" :key="m.handle" type="button" @click="act('EXPAND', m.handle)">Expand {{ m.path }}</button>
          </div>
        </template>

        <ol class="history" aria-label="History">
          <li v-for="x in [...log].reverse()" :key="x.n">
            <button type="button" :class="{ on: current && x.n === current.n }" @click="selected = x.n">
              <span :class="['dot', state(x.reply)]" />
              <span class="h-req">{{ reqSummary(x) }}</span>
              <span class="h-rep">{{ replySummary(x.reply) }}</span>
              <span class="h-ms">{{ x.ms.toFixed(1) }} ms</span>
            </button>
          </li>
        </ol>
      </section>
    </div>
  </div>
</template>

<style scoped>
.pg { max-width: 1360px; margin: 0 auto; padding: 32px 24px 80px; }
.pg-head { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 24px; align-items: end; margin-bottom: 24px; }
.pg-head h1 { font-family: var(--font-head); font-size: 2rem; font-weight: 600; margin: 0 0 8px; }
.pg-head p { color: var(--vp-c-text-2); max-width: 70ch; margin: 0; line-height: 1.55; }
.presets { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; max-width: 560px; }
.presets button, .quick button { font: inherit; font-size: 0.84rem; padding: 7px 12px; border-radius: 999px; border: 1px solid var(--vp-c-border); background: var(--vp-c-bg); color: var(--vp-c-text-1); cursor: pointer; }
.presets button:hover, .quick button:hover { border-color: var(--vp-c-brand-1); }
.loading, .fatal { color: var(--vp-c-text-2); padding: 48px 0; }
.fatal { color: var(--state-red); }

.grid { display: grid; grid-template-columns: 400px minmax(0, 1fr); gap: 20px; align-items: start; }
.pane { background: var(--vp-c-bg-elv); border: 1px solid var(--vp-c-divider); border-radius: 14px; }
.agent { padding: 18px; display: flex; flex-direction: column; gap: 12px; position: sticky; top: calc(var(--vp-nav-height) + 16px); max-height: calc(100vh - var(--vp-nav-height) - 32px); overflow: auto; }

.seg, .verbs, .tabs { display: flex; gap: 4px; background: var(--vp-c-bg-soft); padding: 4px; border-radius: 10px; }
.seg button, .verbs button, .tabs button { flex: 1; font: inherit; font-size: 0.82rem; font-weight: 600; padding: 7px 6px; border: 0; border-radius: 7px; background: none; color: var(--vp-c-text-2); cursor: pointer; }
.verbs button { font-family: var(--vp-font-family-mono); font-size: 0.74rem; letter-spacing: 0.02em; }
.seg button.on, .verbs button.on, .tabs button.on { background: var(--vp-c-bg-elv); color: var(--vp-c-text-1); box-shadow: 0 0 0 1px var(--vp-c-divider); }

.field { display: flex; flex-direction: column; gap: 6px; font-size: 0.82rem; color: var(--vp-c-text-2); font-weight: 600; }
.field em { font-weight: 400; font-style: normal; color: var(--vp-c-text-3); }
select { appearance: none; padding-right: 30px !important; background-image: linear-gradient(45deg, transparent 50%, var(--vp-c-text-3) 50%), linear-gradient(135deg, var(--vp-c-text-3) 50%, transparent 50%); background-position: calc(100% - 16px) 55%, calc(100% - 11px) 55%; background-size: 5px 5px; background-repeat: no-repeat; }
select, input:not([type]), input[inputmode], textarea { font: inherit; font-size: 0.88rem; font-weight: 400; color: var(--vp-c-text-1); background: var(--vp-c-bg); border: 1px solid var(--vp-c-border); border-radius: 8px; padding: 8px 10px; width: 100%; }
textarea { font-family: var(--vp-font-family-mono); font-size: 0.8rem; line-height: 1.55; resize: vertical; }
textarea[aria-invalid="true"] { border-color: var(--state-red); }
.hint { font-size: 0.82rem; color: var(--vp-c-text-3); margin: -4px 0 0; line-height: 1.45; }
.err { font-size: 0.82rem; color: var(--state-red); margin: 0; }
.toggle { display: flex; gap: 8px; align-items: flex-start; font-size: 0.85rem; color: var(--vp-c-text-2); cursor: pointer; }
.toggle input { margin-top: 3px; accent-color: var(--amber); }
.budget { display: flex; gap: 12px; align-items: center; }
.budget input { flex: 1; accent-color: var(--amber); }
.budget output { font-family: var(--vp-font-family-mono); font-size: 0.85rem; min-width: 3.5em; text-align: right; }
.send { font: inherit; font-weight: 700; font-size: 0.95rem; height: 44px; border: 0; border-radius: 9px; background: var(--vp-button-brand-bg); color: var(--vp-button-brand-text); cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 10px; }
.send:hover { background: var(--vp-button-brand-hover-bg); }
.send:disabled { opacity: 0.6; cursor: progress; }
.send kbd { font-family: var(--vp-font-family-mono); font-size: 0.72rem; opacity: 0.7; }

.policy { border-top: 1px solid var(--vp-c-divider); padding-top: 12px; margin-top: 4px; }
.policy summary { font-family: var(--font-head); font-weight: 600; cursor: pointer; margin-bottom: 8px; }
.policy > * + * { margin-top: 10px; }
.checks { display: flex; flex-wrap: wrap; gap: 8px 16px; font-size: 0.85rem; color: var(--vp-c-text-2); }
.checks input { accent-color: var(--amber); }
.row3 { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.grant code { font-size: 0.72rem; color: var(--vp-c-text-3); word-break: break-all; }
.grant pre { margin: 6px 0 0; font-family: var(--vp-font-family-mono); font-size: 0.74rem; line-height: 1.6; color: var(--vp-c-text-2); background: var(--vp-c-bg-soft); padding: 8px 10px; border-radius: 8px; white-space: pre-wrap; overflow-wrap: anywhere; }

.out { padding: 0; overflow: hidden; }
.out-head { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; padding: 14px 18px; border-bottom: 1px solid var(--vp-c-divider); }
.badge { font-family: var(--vp-font-family-mono); font-size: 0.76rem; font-weight: 700; padding: 3px 9px; border-radius: 6px; border: 1px solid currentColor; }
.badge.green { color: var(--state-green); }
.badge.amber { color: var(--state-amber); }
.badge.red { color: var(--state-red); }
.badge.plain { color: var(--vp-c-text-2); }
.req { font-family: var(--vp-font-family-mono); font-size: 0.8rem; color: var(--vp-c-text-2); }
.tok { margin-left: auto; font-size: 0.78rem; color: var(--vp-c-text-3); font-variant-numeric: tabular-nums; }
.tabs { margin: 12px 18px 0; width: fit-content; }
.tabs button { flex: none; padding: 6px 14px; }
.tabs .copy { margin-left: 8px; font-weight: 500; color: var(--vp-c-text-3); }

.lens { font-family: var(--vp-font-family-mono); font-size: 13px; line-height: 1.75; padding: 16px 18px 20px; overflow-x: auto; min-height: 120px; }
.ln { white-space: pre-wrap; overflow-wrap: anywhere; padding-left: 2ch; text-indent: -2ch; color: var(--vp-c-text-1); }
.ln.amber { color: var(--state-amber); }
.ln.green { color: var(--state-green); }
.ln.red { color: var(--state-red); }
.ln.effect { color: var(--vp-c-text-2); }
.ln.more, .ln.event { color: var(--vp-c-text-3); }
.frames { padding: 8px 18px 18px; }
.frames h3 { font-size: 0.8rem; color: var(--vp-c-text-3); margin: 14px 0 6px; font-family: var(--vp-font-family-base); font-weight: 600; }
.frames pre { margin: 0 0 8px; font-family: var(--vp-font-family-mono); font-size: 0.76rem; line-height: 1.55; background: var(--vp-code-block-bg); padding: 12px 14px; border-radius: 8px; overflow: auto; max-height: 360px; }

.quick { display: flex; flex-wrap: wrap; gap: 8px; padding: 0 18px 18px; }
.consent { margin: 0 18px 18px; padding: 16px 18px; border: 1px solid var(--state-amber); border-radius: 12px; background: var(--vp-c-brand-soft); }
.consent h3 { font-family: var(--font-head); font-size: 1.05rem; margin: 0 0 6px; }
.consent p { margin: 6px 0; font-size: 0.9rem; color: var(--vp-c-text-2); }
.consent .what { color: var(--vp-c-text-1); font-weight: 600; }
.consent ul { margin: 8px 0; padding-left: 18px; font-size: 0.84rem; }
.consent .meta, .consent .fine { font-size: 0.8rem; color: var(--vp-c-text-3); }
.actions { margin-top: 12px; }
.approve { font: inherit; font-weight: 700; padding: 10px 16px; border-radius: 8px; border: 0; background: var(--vp-button-brand-bg); color: var(--vp-button-brand-text); cursor: pointer; }

.history { list-style: none; margin: 0; padding: 8px; border-top: 1px solid var(--vp-c-divider); max-height: 260px; overflow: auto; }
.history button { width: 100%; display: grid; grid-template-columns: 10px minmax(0, 1fr) auto auto; gap: 10px; align-items: center; padding: 7px 10px; border: 0; border-radius: 7px; background: none; color: var(--vp-c-text-2); font: inherit; font-size: 0.8rem; text-align: left; cursor: pointer; }
.history button:hover, .history button.on { background: var(--vp-c-bg-soft); color: var(--vp-c-text-1); }
.dot { width: 8px; height: 8px; border-radius: 2px; background: var(--vp-c-text-3); }
.dot.green { background: var(--state-green); }
.dot.amber { background: var(--state-amber); }
.dot.red { background: var(--state-red); }
.h-req { font-family: var(--vp-font-family-mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.h-rep { font-family: var(--vp-font-family-mono); font-size: 0.74rem; }
.h-ms { font-size: 0.72rem; color: var(--vp-c-text-3); font-variant-numeric: tabular-nums; }

@media (max-width: 980px) {
  .pg-head { grid-template-columns: 1fr; }
  .presets { justify-content: flex-start; }
  .grid { grid-template-columns: 1fr; }
  .agent { position: static; max-height: none; }
  .tok { margin-left: 0; width: 100%; }
}
@media (max-width: 640px) {
  .pg { padding: 20px 16px 64px; }
  .lens { font-size: 11.5px; }
  .row3 { grid-template-columns: 1fr 1fr; }
}
</style>
