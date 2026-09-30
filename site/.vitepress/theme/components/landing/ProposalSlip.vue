<script setup lang="ts">
/**
 * The hero's proposal slip: the proposal the chosen example's service made. The top half is
 * what it proposes; the tear-off stub below is the consent the visitor signs, then the
 * receipt, then the undo. It arrives once the thread above it has played, and its colour
 * follows the state. Why it asks is the thread's last message, so the slip doesn't repeat it.
 */
import { computed, useId } from 'vue';
import SlipStub from './SlipStub.vue';
import { keepDates } from './slip-view';
import { phaseTone } from './tone';
import type { Phase, SlipModel } from './use-slip';

const props = defineProps<{
  s: SlipModel;
  /** Not arrived yet: the thread is still playing. It keeps its place, hidden and inert. */
  away: boolean;
}>();
const titleId = useId();

/** The chip's words for each phase; its colour is the phase's tone (tone.ts). */
const CHIP: Record<Exclude<Phase, 'loading'>, string> = {
  unavailable: 'Recorded',
  checking: 'Checking your policy…',
  waiting: 'Waiting on you',
  approving: 'Waiting on you',
  committed: '✓ Committed',
  undoing: '✓ Committed',
  undone: 'Undone',
  expired: 'Expired',
  error: "✗ Didn't go through",
};

/**
 * The chip: the protocol state in a word, coloured by it. While the recording shows it's
 * neutral, since nothing live waits yet; the band around the slip still shows its amber.
 */
const state = computed(() => {
  const p = props.s.phase;

  if (p === 'loading') {
    return { tone: 'plain', text: 'Recorded' };
  }

  const within = props.s.progress.outcome === 'within';

  return {
    tone: phaseTone(p),
    text: within && p === 'committed' ? '✓ Went ahead' : CHIP[p],
  };
});
</script>

<template>
  <article data-slip :class="['slip', state.tone, { pending: away }]" :aria-labelledby="titleId" :aria-hidden="away || undefined" :inert="away || undefined">
    <header class="head">
      <p class="kind">Proposal <span class="mono">{{ s.slip.id }}</span> from {{ s.slip.service }}</p>
      <p v-if="state.text" class="chip">{{ state.text }}</p>
    </header>
    <h2 :id="titleId" class="summary"><template v-for="(part, i) in keepDates(s.slip.summary)" :key="i"><span v-if="part.date" class="nowrap">{{ part.text }}</span><template v-else>{{ part.text }}</template></template></h2>
    <ul class="effects" aria-label="What it changes">
      <li v-for="e in s.slip.effects" :key="e">{{ e }}</li>
    </ul>
    <dl class="facts">
      <div><dt>Uses</dt><dd>{{ s.slip.uses }}</dd></div>
      <div><dt>Risk</dt><dd>{{ s.slip.risk }}</dd></div>
      <div><dt>Undo</dt><dd>{{ s.slip.undo }}</dd></div>
    </dl>
    <SlipStub :s="s" :away="away" />
  </article>
</template>

<style scoped>
.slip { --edge: var(--vp-c-border); --tone: var(--vp-c-text-2); position: relative; background: var(--vp-c-bg-elv); border: 1px solid var(--edge); border-radius: 14px; padding: clamp(20px, 2.2vw, 28px); display: grid; gap: 14px; transition: border-color 300ms var(--l-ease), opacity 450ms var(--l-ease-out), transform 450ms var(--l-ease-out); }
/* Before the service has proposed there is no slip yet: it keeps its place, and arrives. */
.slip.pending { opacity: 0; transform: translateY(12px); visibility: hidden; transition: none; }
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

.facts { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin: 0; padding: 10px 0; border-block: 1px solid var(--vp-c-divider); }
.facts dt { font-size: 0.8125rem; font-weight: 600; color: var(--vp-c-text-2); }
.facts dd { margin: 2px 0 0; font-weight: 650; }

</style>
