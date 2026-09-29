<script setup lang="ts">
/**
 * The hero's proposal slip: a real proposal from the example shop, waiting on the visitor.
 * The top half is what the service proposes; the tear-off stub below is the consent the
 * visitor signs, then the receipt, then the undo. Colour follows the protocol state.
 */
import { computed, useId } from 'vue';
import SlipStub from './SlipStub.vue';
import { keepDates } from './slip-view';
import { useSlip } from './use-slip';

const {
  phase,
  live,
  slip,
  receipt,
  undone,
  status,
  error,
  approve,
  undo,
  again,
} = useSlip();
const titleId = useId();

/** The chip: the protocol state in a word, coloured by it; neutral until the core is live. */
const state = computed(() => {
  switch (phase.value) {
    case 'waiting':
    case 'approving':
      return { tone: 'amber', text: 'Waiting on you' };
    case 'committed':
    case 'undoing':
      return { tone: 'green', text: '✓ Committed' };
    case 'undone':
      return { tone: 'plain', text: '↶ Undone' };
    case 'expired':
      return { tone: 'plain', text: 'Expired' };
    case 'error':
      return { tone: 'red', text: "✗ Didn't go through" };
    default:
      return {
        tone: 'plain',
        text: live.value ? 'Starting again…' : 'Recorded',
      };
  }
});
</script>

<template>
  <article :class="['slip', state.tone]" :aria-labelledby="titleId">
    <header class="head">
      <p class="kind">Proposal <span class="mono">{{ slip.id }}</span> from {{ slip.service }}</p>
      <p class="chip">{{ state.text }}</p>
    </header>
    <h2 :id="titleId" class="summary"><template v-for="(part, i) in keepDates(slip.summary)" :key="i"><span v-if="part.date" class="nowrap">{{ part.text }}</span><template v-else>{{ part.text }}</template></template></h2>
    <ul class="effects" aria-label="What it changes">
      <li v-for="e in slip.effects" :key="e">{{ e }}</li>
    </ul>
    <dl class="facts">
      <div><dt>Uses</dt><dd>{{ slip.uses }}</dd></div>
      <div><dt>Risk</dt><dd>{{ slip.risk }}</dd></div>
      <div><dt>Undo</dt><dd>{{ slip.undo }}</dd></div>
    </dl>
    <p class="reason"><span class="label">Why it's asking</span> <span class="mono">{{ slip.reason }}</span></p>
    <SlipStub
      :phase="phase"
      :live="live"
      :slip="slip"
      :receipt="receipt"
      :undone="undone"
      :status="status"
      :error="error"
      @approve="approve"
      @undo="undo"
      @again="again"
    />
  </article>
</template>

<style scoped>
.slip { --edge: var(--vp-c-border); --tone: var(--vp-c-text-2); position: relative; background: var(--vp-c-bg-elv); border: 1px solid var(--edge); border-radius: 14px; padding: clamp(20px, 3vw, 28px); display: grid; gap: 16px; transition: border-color 300ms var(--l-ease); }
.slip.amber { --edge: var(--state-amber); --tone: var(--state-amber); }
.slip.green { --edge: var(--state-green); --tone: var(--state-green); }
.slip.red { --edge: var(--state-red); --tone: var(--state-red); }
.slip.plain { --tone: var(--vp-c-text-1); }

.head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 16px; }
.kind { font-size: 0.875rem; color: var(--vp-c-text-2); }
.mono { font-family: var(--l-mono); font-size: 0.92em; }
.chip { font-size: 0.8125rem; font-weight: 650; color: var(--tone); border: 1px solid currentColor; border-radius: 999px; padding: 2px 10px; white-space: nowrap; }

.nowrap { white-space: nowrap; }
.summary { font-size: clamp(1.3rem, 1.1rem + 0.8vw, 1.6rem); font-weight: 700; line-height: 1.2; letter-spacing: -0.015em; }
.effects { list-style: none; margin: 0; padding: 0; font-family: var(--l-mono); font-size: 0.8125rem; line-height: 1.7; color: var(--vp-c-text-2); }
.effects li { padding-left: 2ch; text-indent: -2ch; overflow-wrap: anywhere; }

.facts { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin: 0; padding: 14px 0; border-block: 1px solid var(--vp-c-divider); }
.facts dt { font-size: 0.8125rem; font-weight: 600; color: var(--vp-c-text-2); }
.facts dd { margin: 2px 0 0; font-weight: 650; }
.reason { font-size: 0.9rem; color: var(--vp-c-text-2); display: grid; gap: 2px; }
.reason .label { font-weight: 600; }
.reason .mono { color: var(--vp-c-text-1); overflow-wrap: anywhere; }

@media (max-width: 480px) {
  .facts { grid-template-columns: 1fr 1fr; }
}
</style>
