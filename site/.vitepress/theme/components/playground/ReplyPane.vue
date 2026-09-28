<script setup lang="ts">
/**
 * What the model reads for one exchange: the reply's state and token counts, then its Lens
 * (with a copy button) or, on the Frames tab, the raw request, events and reply.
 */
import { ref } from 'vue';
import { replySummary, requestSummary, toneOf } from './labels';
import type { LensView } from './lens-lines';
import type { Exchange } from './model';

const props = defineProps<{ exchange: Exchange; view: LensView }>();

/** How long "Copied" shows after a copy. */
const COPIED_MS = 1200;

const tab = ref<'lens' | 'json'>('lens');
const copied = ref(false);
const pretty = (v: unknown) => JSON.stringify(v, null, 2);

async function copyLens() {
  await navigator.clipboard.writeText(props.view.text);
  copied.value = true;
  setTimeout(() => {
    copied.value = false;
  }, COPIED_MS);
}
</script>

<template>
  <div class="out-head">
    <span :class="['badge', toneOf(exchange.reply)]">{{ replySummary(exchange.reply) }}</span>
    <span class="req">{{ requestSummary(exchange.request) }}</span>
    <span class="tok" title="Shared token estimate (SPEC §8)">
      Lens {{ view.tokens.lens }} · JSON {{ view.tokens.json }} · pretty JSON {{ view.tokens.pretty }} tokens
    </span>
  </div>
  <div class="tabs" role="tablist">
    <button type="button" role="tab" :aria-selected="tab === 'lens'" :class="{ on: tab === 'lens' }" @click="tab = 'lens'">Lens</button>
    <button type="button" role="tab" :aria-selected="tab === 'json'" :class="{ on: tab === 'json' }" @click="tab = 'json'">Frames</button>
    <button v-if="tab === 'lens'" type="button" class="copy" @click="copyLens">{{ copied ? "Copied" : "Copy" }}</button>
  </div>

  <div v-if="tab === 'lens'" class="lens">
    <div v-for="(e, i) in view.events" :key="'e' + i" class="ln event">{{ e }}</div>
    <div v-for="(l, i) in view.lines" :key="i" :class="['ln', l.cls]">{{ l.text }}</div>
  </div>
  <div v-else class="frames">
    <h3>Request</h3>
    <pre>{{ pretty(exchange.request) }}</pre>
    <template v-if="exchange.events.length">
      <h3>Events</h3>
      <pre v-for="(e, i) in exchange.events" :key="i">{{ pretty(e) }}</pre>
    </template>
    <h3>Reply</h3>
    <pre>{{ pretty(exchange.reply) }}</pre>
  </div>
</template>

<style scoped src="./segmented.css"></style>
<style scoped>
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

@media (max-width: 980px) {
  .tok { margin-left: 0; width: 100%; }
}
@media (max-width: 640px) {
  .lens { font-size: 11.5px; }
}
</style>
