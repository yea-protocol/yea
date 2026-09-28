<script setup lang="ts">
/** Every exchange so far, newest first; pick one to show it in the reply pane. */
import { computed } from 'vue';
import { replySummary, requestSummary, toneOf } from './labels';
import type { Exchange } from './model';

const props = defineProps<{ log: Exchange[]; active: number | null }>();
const emit = defineEmits<{ select: [n: number] }>();

const newestFirst = computed(() => [...props.log].reverse());
</script>

<template>
  <ol class="history" aria-label="History">
    <li v-for="x in newestFirst" :key="x.n">
      <button type="button" :class="{ on: x.n === active }" @click="emit('select', x.n)">
        <span :class="['dot', toneOf(x.reply)]" />
        <span class="h-req">{{ requestSummary(x.request) }}</span>
        <span class="h-rep">{{ replySummary(x.reply) }}</span>
        <span class="h-ms">{{ x.ms.toFixed(1) }} ms</span>
      </button>
    </li>
  </ol>
</template>

<style scoped>
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
</style>
