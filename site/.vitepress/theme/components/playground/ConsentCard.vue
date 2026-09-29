<script setup lang="ts">
/**
 * The approval card for a consent_required reply: once the request checks out against the
 * proposal the agent received, it shows exactly what the human is approving, with one button.
 */
import type { ConsentCheck, ConsentFacts } from './use-consent';

defineProps<{
  message: string;
  service: string;
  check: ConsentCheck;
  facts: ConsentFacts | null;
}>();

const emit = defineEmits<{ approve: [] }>();
</script>

<template>
  <div class="consent" role="region" aria-label="Approval needed">
    <h3>Your agent needs your approval</h3>
    <p class="reason">{{ message }}</p>
    <template v-if="facts && check === 'ok'">
      <p class="what">{{ facts.summary }}</p>
      <ul>
        <li v-for="(e, i) in facts.effects" :key="i"><code>{{ e }}</code></li>
      </ul>
      <p class="meta">{{ facts.meta }}. Hash checked against the proposal the agent received.</p>
      <div class="actions">
        <button type="button" class="approve" @click="emit('approve')">Approve as human and commit</button>
      </div>
      <p class="fine">Signs a one-time grant: COMMIT of this proposal hash, at {{ service }}, until it expires. Nothing else.</p>
    </template>
    <p v-else-if="check === 'mismatch'" class="err">This consent request doesn't match a proposal the agent received, so it can't be approved here.</p>
  </div>
</template>

<style scoped>
.consent { margin: 0 18px 18px; padding: 16px 18px; border: 1px solid var(--state-amber); border-radius: 12px; background: var(--state-amber-soft); }
.consent h3 { font-family: var(--font-head); font-size: 1.2rem; font-weight: 650; line-height: 1.3; margin: 0 0 8px; }
.consent p { margin: 6px 0; font-size: 0.875rem; color: var(--vp-c-text-2); }
/* The service's reason is machine output, so it's set in mono (the Machine Voice Rule). */
.consent .reason { font-family: var(--vp-font-family-mono); font-size: 0.8125rem; }
.consent .what { color: var(--vp-c-text-1); font-weight: 600; }
.consent ul { margin: 8px 0; padding-left: 18px; font-size: 0.84rem; }
/* The small print is text-2 so it reads comfortably at 0.8rem on the amber tint. */
.consent .meta, .consent .fine { font-size: 0.8rem; color: var(--vp-c-text-2); }
.actions { margin-top: 12px; }
.approve { font: inherit; font-weight: 700; padding: 10px 16px; border-radius: 8px; border: 0; background: var(--consent-bg); color: var(--consent-text); cursor: pointer; }
.approve:hover { background: var(--consent-hover-bg); }

@media (max-width: 640px), (pointer: coarse) {
  .approve { min-height: 44px; }
}
</style>
