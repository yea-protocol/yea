<script setup lang="ts">
/**
 * The approval card for a consent_required reply: once the request checks out against the
 * proposal the agent committed, it shows exactly what the human is approving, with Approve and
 * Decline; otherwise it says why it can't be approved. Once declined, nothing waits on the
 * human, so the card turns neutral. It keeps what was declined (so it can still be read, and
 * the history below doesn't jump up under the pointer), says that nothing was signed, and
 * offers Ask again: a fresh proposal, never the declined one. When it was this card's Decline
 * that was pressed, the card keeps its height and focus moves to that line, since the button
 * is gone; a declined exchange picked from the history leaves focus where it was.
 */
import { computed, nextTick, ref, useTemplateRef, watch } from 'vue';
import { declinedLine } from '../proposal-facts';
import type { ConsentCheck } from './consent-check';
import type { ConsentFacts } from './use-consent';

const props = defineProps<{
  message: string;
  service: string;
  check: ConsentCheck;
  facts: ConsentFacts | null;
  /** Whether Ask again has an INTENT to send afresh. */
  askable: boolean;
}>();

const emit = defineEmits<{ approve: []; decline: []; again: [] }>();
const said = useTemplateRef<HTMLElement>('said');
const card = useTemplateRef<HTMLElement>('card');
/** Whether the Decline here was pressed since the card last changed state. */
let pressed = false;
/**
 * The card's height when its Decline was pressed, kept while it says what was declined, so
 * nothing below moves up under the pointer; 0 otherwise.
 */
const held = ref(0);
const declined = computed(() =>
  props.check.state === 'declined' ? declinedLine(props.check.expires) : '',
);

function decline() {
  held.value = card.value?.offsetHeight ?? 0;
  pressed = true;
  emit('decline');
}

/**
 * Ask again on a fresh click only: once Decline is gone, a double-click's second click
 * (`detail` 2) can land here, and mustn't send anything.
 */
function again(e: MouseEvent) {
  if (e.detail < 2) {
    emit('again');
  }
}

watch(declined, async (now, before) => {
  const mine = pressed;

  pressed = false;

  if (!(now && !before && mine)) {
    held.value = 0;

    return;
  }

  await nextTick();
  said.value?.focus();
});
</script>

<template>
  <div v-if="declined" ref="card" class="consent settled" role="region" aria-label="Declined" :style="held ? { minHeight: `${held}px` } : undefined">
    <h3>You declined</h3>
    <p class="reason">{{ message }}</p>
    <template v-if="facts">
      <p class="what">{{ facts.summary }}</p>
      <ul>
        <li v-for="(e, i) in facts.effects" :key="i"><code>{{ e }}</code></li>
      </ul>
      <p class="meta">{{ facts.meta }}.</p>
    </template>
    <p ref="said" class="what said" tabindex="-1">{{ declined }}</p>
    <div v-if="askable" class="actions">
      <button type="button" class="secondary" @click="again">Ask again</button>
    </div>
  </div>
  <div v-else ref="card" class="consent" role="region" aria-label="Approval needed">
    <h3>Your agent needs your approval</h3>
    <p class="reason">{{ message }}</p>
    <template v-if="facts && check.state === 'ok'">
      <p class="what">{{ facts.summary }}</p>
      <ul>
        <li v-for="(e, i) in facts.effects" :key="i"><code>{{ e }}</code></li>
      </ul>
      <p class="meta">{{ facts.meta }}. Hash checked against the proposal the agent received.</p>
      <div class="actions">
        <button type="button" class="approve" @click="emit('approve')">Approve as human and commit</button>
        <button type="button" class="secondary" @click="decline()">Decline</button>
      </div>
      <p class="fine">Signs a one-time grant: COMMIT of this proposal hash, at {{ service }}, until it expires. Nothing else.</p>
    </template>
    <p v-else-if="check.state === 'refused'" class="err">This consent request can't be approved here: {{ check.why }}.</p>
  </div>
</template>

<style scoped>
.consent { margin: 0 18px 18px; padding: 16px 18px; border: 1px solid var(--state-amber); border-radius: 12px; background: var(--state-amber-soft); }
.consent h3 { font-family: var(--font-head); font-size: 1.25rem; font-weight: 600; line-height: 1.35; margin: 0 0 8px; } /* Subsection */
.consent p { margin: 6px 0; font-size: 0.875rem; color: var(--vp-c-text-2); }
/* The service's reason is machine output, so it's set in mono (the Machine Voice Rule). */
.consent .reason { font-family: var(--vp-font-family-mono); font-size: 0.8125rem; }
.consent .what { color: var(--vp-c-text-1); font-weight: 600; }
.consent ul { margin: 8px 0; padding-left: 18px; font-size: 0.84rem; }
/* The small print is text-2 so it reads comfortably at 0.8rem on the amber tint. */
.consent .meta, .consent .fine { font-size: 0.8rem; color: var(--vp-c-text-2); }
/* Declined: nothing waits on the human any more, so the card leaves amber for the neutral fill. */
.consent.settled { border-color: var(--vp-c-divider); background: var(--vp-c-bg-soft); }
.actions { margin-top: 12px; display: flex; flex-wrap: wrap; gap: 10px; }
.approve, .secondary { font: inherit; font-weight: 700; padding: 10px 16px; border-radius: 8px; cursor: pointer; }
.approve { border: 1px solid var(--consent-bg); background: var(--consent-bg); color: var(--consent-text); }
.approve:hover { background: var(--consent-hover-bg); border-color: var(--consent-hover-bg); }
/* Decline and Ask again are the neutral secondary: no amber, since they sign nothing. */
.secondary { border: 1px solid var(--vp-c-border); background: transparent; color: var(--vp-c-text-1); }
.secondary:hover { border-color: var(--vp-c-text-3); }
.consent .said { margin-top: 10px; }

@media (max-width: 640px), (pointer: coarse) {
  .approve, .secondary { min-height: 44px; }
}
</style>
