<script setup lang="ts">
/**
 * The lead-up above the slip: four stops from the person's request to the outcome (the agent
 * asks, the service proposes, the policy checks, then the person decides or it goes ahead),
 * with the current stop's sentence and the wire line behind it. At rest it shows the last stop,
 * which says why the slip is waiting on the visitor or went ahead.
 */
import { computed } from 'vue';
import { type Progress, stops } from './trail';

const props = defineProps<{
  progress: Progress;
  /** The stop the run has reached, 0 to 3. */
  at: number;
}>();

const list = computed(() => stops(props.progress));
const now = computed(() => list.value[props.at]);
</script>

<template>
  <div class="lead">
    <ol class="track" :style="{ '--at': at }" aria-label="How it got here">
      <li v-for="(s, i) in list" :key="i" :class="{ done: i < at, now: i === at }" :aria-current="i === at ? 'step' : undefined">
        <span class="dot" aria-hidden="true" />
        <span class="label">{{ s.label }}</span>
      </li>
    </ol>
    <Transition name="stop" mode="out-in">
      <div :key="`${at}:${now.wire}`" class="said">
        <p class="text">{{ now.text }}</p>
        <p class="wire" :title="now.wire">{{ now.wire }}</p>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.lead { display: grid; gap: 14px; }

/* The track: a rule through four dots; its filled part grows to the current stop. */
.track { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); position: relative; }
.track::before, .track::after { content: ""; position: absolute; top: 7px; left: 12.5%; right: 12.5%; height: 2px; background: var(--vp-c-border); }
.track::after { background: var(--vp-c-text-1); transform-origin: left center; transform: scaleX(calc(var(--at) / 3)); transition: transform 700ms var(--l-ease-out); }
.track li { position: relative; z-index: 1; display: grid; justify-items: center; align-content: start; gap: 8px; text-align: center; }
.dot { width: 16px; height: 16px; border-radius: 50%; border: 2px solid var(--vp-c-border); background: var(--vp-c-bg); transition: background-color 300ms var(--l-ease-out), border-color 300ms var(--l-ease-out); }
.done .dot, .now .dot { border-color: var(--vp-c-text-1); background: var(--vp-c-text-1); }
.now .dot { outline: 2px solid var(--vp-c-text-1); outline-offset: 3px; }
.label { font-size: 0.8125rem; font-weight: 600; line-height: 1.3; color: var(--vp-c-text-2); }
.done .label, .now .label { color: var(--vp-c-text-1); }

/* The current stop: three lines kept for its sentence, so the slip below doesn't jump. */
.said { display: grid; gap: 6px; }
.text { font-size: 1rem; font-weight: 600; line-height: 1.45; min-height: calc(3 * 1.45em); max-width: 52ch; }
.wire { font-family: var(--l-mono); font-size: 0.75rem; line-height: 1.5; color: var(--vp-c-text-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.stop-enter-active, .stop-leave-active { transition: opacity 220ms var(--l-ease-out), transform 220ms var(--l-ease-out); }
.stop-enter-from { opacity: 0; transform: translateY(6px); }
.stop-leave-to { opacity: 0; transform: translateY(-4px); }

@media (max-width: 480px) {
  .label { font-size: 0.75rem; }
  .text { min-height: calc(4 * 1.45em); }
}
@media (max-width: 380px) {
  .text { min-height: calc(6 * 1.45em); }
}
</style>
