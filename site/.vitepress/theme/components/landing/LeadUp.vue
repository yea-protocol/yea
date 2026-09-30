<script setup lang="ts">
/**
 * The lead-up above the slip: four stops from the person's request to the outcome (the agent
 * asks, the service proposes, the policy checks, then the person decides or it goes ahead),
 * with the chosen stop's sentence and the wire line behind it. It rests on the last stop, which
 * says why the slip waits on the visitor or went ahead; the visitor steps back through the
 * others (a tablist, or Next), and the slip and band show each stop as it was.
 */
import { computed, useId } from 'vue';
import { focusSibling, moveIndex } from '../playground/roving';
import { LAST_STOP, type Progress, stops } from './trail';

const props = defineProps<{
  progress: Progress;
  /** The stop on show, 0 to LAST_STOP. */
  at: number;
}>();
const emit = defineEmits<{ see: [stop: number] }>();
const id = useId();

const list = computed(() => stops(props.progress));
const now = computed(() => list.value[props.at]);
/** Next goes one stop on; from the outcome, it goes back to the start. */
const next = computed(() =>
  props.at < LAST_STOP
    ? { to: props.at + 1, text: `Next: ${list.value[props.at + 1].label}` }
    : { to: 0, text: 'Walk through how it got here' },
);

function onKey(e: KeyboardEvent, i: number) {
  const to = moveIndex(e.key, i, list.value.length, 'horizontal');

  if (to !== null) {
    e.preventDefault();
    emit('see', to);
    focusSibling(e, to);
  }
}
</script>

<template>
  <div class="lead">
    <div class="track" role="tablist" aria-label="How it got here" :style="{ '--at': at }">
      <button
        v-for="(s, i) in list"
        :id="`${id}-stop-${i}`"
        :key="i"
        type="button"
        role="tab"
        :class="{ done: i < at, now: i === at }"
        :aria-selected="i === at"
        :aria-controls="`${id}-said`"
        :tabindex="i === at ? 0 : -1"
        @click="emit('see', i)"
        @keydown="onKey($event, i)"
      >
        <span class="dot" aria-hidden="true" />
        <span class="label">{{ s.label }}</span>
      </button>
    </div>
    <div :id="`${id}-said`" role="tabpanel" :aria-labelledby="`${id}-stop-${at}`" class="panel">
      <Transition name="stop" mode="out-in">
        <div :key="`${at}:${now.wire}`" class="said">
          <p class="text">{{ now.text }}</p>
          <p class="wire" :title="now.wire">{{ now.wire }}</p>
        </div>
      </Transition>
      <button type="button" class="next" @click="emit('see', next.to)">{{ next.text }} <span aria-hidden="true">{{ at < LAST_STOP ? '→' : '↺' }}</span></button>
    </div>
  </div>
</template>

<style scoped>
.lead { display: grid; gap: 14px; }

/* The track: a rule through four dots; its filled part grows to the current stop. */
.track { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); position: relative; }
.track::before, .track::after { content: ""; position: absolute; top: 7px; left: 12.5%; right: 12.5%; height: 2px; background: var(--vp-c-border); }
.track::after { background: var(--vp-c-text-1); transform-origin: left center; transform: scaleX(calc(var(--at) / 3)); transition: transform 700ms var(--l-ease-out); }
.track button { position: relative; z-index: 1; display: grid; justify-items: center; align-content: start; gap: 8px; min-height: 44px; padding: 0 4px; border: 0; background: none; font: inherit; color: inherit; text-align: center; cursor: pointer; }
.track button:hover .label { text-decoration: underline; text-underline-offset: 0.2em; }
.dot { width: 16px; height: 16px; border-radius: 50%; border: 2px solid var(--vp-c-border); background: var(--vp-c-bg); transition: background-color 300ms var(--l-ease-out), border-color 300ms var(--l-ease-out); }
.done .dot, .now .dot { border-color: var(--vp-c-text-1); background: var(--vp-c-text-1); }
.now .dot { outline: 2px solid var(--vp-c-text-1); outline-offset: 3px; }
.label { font-size: 0.8125rem; font-weight: 600; line-height: 1.3; color: var(--vp-c-text-2); }
.done .label, .now .label { color: var(--vp-c-text-1); }

/* The current stop: three lines kept for its sentence, so the slip below doesn't jump. */
.panel { display: grid; gap: 10px; }
.said { display: grid; gap: 6px; }
/* Next: a button with a link's look, a 44px target. */
.next { justify-self: start; min-height: 44px; padding: 0; border: 0; background: none; font: inherit; font-size: 0.9375rem; font-weight: 650; color: var(--vp-c-text-1); text-decoration: underline; text-decoration-color: var(--vp-c-text-3); text-underline-offset: 0.2em; cursor: pointer; }
.next:hover { text-decoration-color: currentColor; }
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
