<script setup lang="ts">
/**
 * What the model reads for one exchange: the reply's state and token counts, then two tabs
 * (WAI-ARIA tabs pattern): its Lens, which a button beside the tabs copies, and the raw
 * request, events and reply.
 */
import { computed, ref, useId, useTemplateRef } from 'vue';
import { type CopyResult, copyOrSelect } from './clipboard';
import { replySummary, requestSummary, toneOf } from './labels';
import type { LensView } from './lens-lines';
import type { Exchange } from './model';
import { focusSibling, moveIndex } from './roving';
import { copyKeys, isApple } from './shortcut';

const props = defineProps<{ exchange: Exchange; view: LensView }>();

type Tab = 'lens' | 'json';

const TABS: readonly { key: Tab; text: string }[] = [
  { key: 'lens', text: 'Lens' },
  { key: 'json', text: 'Frames' },
];

/** How long the copy button's result shows: long enough to read the fallback's instruction. */
const SHOW_MS: Record<CopyResult, number> = { copied: 1200, selected: 4000 };

const id = useId();
const tab = ref<Tab>('lens');
const copyState = ref<CopyResult | null>(null);
const lensPanel = useTemplateRef<HTMLElement>('lensPanel');
const apple = isApple();
const copyLabel = computed(() =>
  copyState.value === 'copied'
    ? 'Copied'
    : copyState.value === 'selected'
      ? `Selected: press ${copyKeys(apple)}`
      : 'Copy',
);
const pretty = (v: unknown) => JSON.stringify(v, null, 2);
let resetTimer: ReturnType<typeof setTimeout> | undefined;

async function copyLens() {
  const result = await copyOrSelect(props.view.text, lensPanel.value);

  copyState.value = result;
  clearTimeout(resetTimer);
  resetTimer = setTimeout(() => {
    copyState.value = null;
  }, SHOW_MS[result]);
}

function onTabKey(e: KeyboardEvent, i: number) {
  const next = moveIndex(e.key, i, TABS.length);

  if (next === null) {
    return;
  }

  e.preventDefault();
  tab.value = TABS[next].key;
  focusSibling(e, next);
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
  <div class="tools">
    <div class="seg tabs" role="tablist" aria-label="Reply view">
      <button
        v-for="(t, i) in TABS"
        :id="`${id}-tab-${t.key}`"
        :key="t.key"
        type="button"
        role="tab"
        :aria-selected="tab === t.key"
        :aria-controls="`${id}-panel-${t.key}`"
        :tabindex="tab === t.key ? 0 : -1"
        @click="tab = t.key"
        @keydown="onTabKey($event, i)"
      >{{ t.text }}</button>
    </div>
    <button v-if="tab === 'lens'" type="button" class="copy" @click="copyLens">{{ copyLabel }}</button>
  </div>

  <div v-show="tab === 'lens'" :id="`${id}-panel-lens`" ref="lensPanel" class="lens" role="tabpanel" :aria-labelledby="`${id}-tab-lens`" tabindex="0">
    <div v-for="(e, i) in view.events" :key="'e' + i" class="ln event">{{ e }}</div>
    <div v-for="(l, i) in view.lines" :key="i" :class="['ln', l.cls]">{{ l.text }}</div>
  </div>
  <div v-show="tab === 'json'" :id="`${id}-panel-json`" class="frames" role="tabpanel" :aria-labelledby="`${id}-tab-json`">
    <h3>Request</h3>
    <pre tabindex="0">{{ pretty(exchange.request) }}</pre>
    <template v-if="exchange.events.length">
      <h3>Events</h3>
      <pre v-for="(e, i) in exchange.events" :key="i" tabindex="0">{{ pretty(e) }}</pre>
    </template>
    <h3>Reply</h3>
    <pre tabindex="0">{{ pretty(exchange.reply) }}</pre>
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
.tools { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 12px 18px 0; }
.tabs { width: fit-content; }
.tabs > button { flex: none; padding: 6px 14px; }
.copy { font: inherit; font-size: 0.82rem; font-weight: 500; padding: 6px 10px; border: 0; border-radius: 7px; background: none; color: var(--vp-c-text-3); cursor: pointer; }

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
@media (max-width: 640px), (pointer: coarse) {
  .copy { min-height: 44px; }
}
</style>
