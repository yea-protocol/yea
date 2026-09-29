<script setup lang="ts">
/**
 * The agent's side: pick a service and a verb, fill in what that verb needs (capability and
 * params, or an earlier proposal, receipt or handle), set a token budget, and send.
 * The policy panel goes in the default slot, below the send button.
 */
import type { CapabilityInfo } from '@yea-protocol/sdk';
import { computed, useId } from 'vue';
import { type RequestForm, SERVICE_KEYS, SERVICES, VERBS } from './model';
import SegmentedRadio from './SegmentedRadio.vue';
import type { Target } from './seen';
import { isApple, sendHint, sendKeys } from './shortcut';

const props = defineProps<{
  form: RequestForm;
  caps: CapabilityInfo[];
  targets: Target[];
  busy: boolean;
  paramsError: string;
}>();
const emit = defineEmits<{
  pickCapability: [name: string];
  checkParams: [];
  send: [];
}>();

const SERVICE_OPTIONS = SERVICE_KEYS.map((s) => ({
  value: s,
  text: SERVICES[s],
}));
const VERB_OPTIONS = VERBS.map((v) => ({ value: v, text: v }));
const headingId = useId();
const apple = isApple();

const capSummary = computed(
  () => props.caps.find((c) => c.name === props.form.capability)?.summary,
);
const targetLabel = computed(() =>
  props.form.verb === 'COMMIT'
    ? 'Proposal'
    : props.form.verb === 'UNDO'
      ? 'Receipt'
      : 'Handle',
);
const noTargetHint = computed(() =>
  props.form.verb === 'COMMIT'
    ? 'Send an INTENT first to get proposals.'
    : props.form.verb === 'UNDO'
      ? 'Commit something first to get a receipt.'
      : 'Ask with a small budget to get a handle.',
);
</script>

<template>
  <section class="pane agent" :aria-labelledby="headingId">
    <h2 :id="headingId" class="visually-hidden">Your request</h2>
    <SegmentedRadio v-model="form.service" class="services" label="Service" :options="SERVICE_OPTIONS" />
    <SegmentedRadio v-model="form.verb" class="verbs" label="Verb" :options="VERB_OPTIONS" mono />

    <template v-if="form.verb === 'ASK' || form.verb === 'INTENT'">
      <label class="field">
        <span>Capability</span>
        <select :value="form.capability" @change="emit('pickCapability', ($event.target as HTMLSelectElement).value)">
          <option v-for="c in caps" :key="c.name" :value="c.name">{{ c.name }}</option>
        </select>
      </label>
      <p class="hint">{{ capSummary }}</p>
      <label class="field">
        <span>Params</span>
        <textarea v-model="form.params" spellcheck="false" rows="7" :aria-invalid="!!paramsError" @blur="emit('checkParams')" />
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
        <span>{{ targetLabel }}</span>
        <select v-model="form.target" :disabled="!targets.length">
          <option v-for="t in targets" :key="t.value" :value="t.value" :disabled="t.committed">
            {{ t.value }} · {{ t.label }}{{ t.committed ? " (auto-committed)" : "" }}
          </option>
        </select>
      </label>
      <p v-if="!targets.length" class="hint">
        {{ noTargetHint }}
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

    <button class="send" type="button" :disabled="busy" :aria-keyshortcuts="sendKeys(apple)" @click="emit('send')">
      Send {{ form.verb }}<kbd aria-hidden="true">{{ sendHint(apple) }}</kbd>
    </button>

    <slot />
  </section>
</template>

<style scoped src="./controls.css"></style>
<style scoped>
.agent { padding: 18px; display: flex; flex-direction: column; gap: 12px; position: sticky; top: calc(var(--vp-nav-height) + 16px); max-height: calc(100vh - var(--vp-nav-height) - 32px); overflow: auto; }
.budget { display: flex; gap: 12px; align-items: center; }
.budget input { flex: 1; accent-color: var(--vp-c-brand-1); }
.budget output { font-family: var(--vp-font-family-mono); font-size: 0.85rem; min-width: 3.5em; text-align: right; }
/* flex-shrink 0: the pane is a fixed-height column, and shrinking would squash the button below 44px. */
.send { font: inherit; font-weight: 700; font-size: 0.95rem; height: 44px; flex-shrink: 0; border: 0; border-radius: 9px; background: var(--vp-button-brand-bg); color: var(--vp-button-brand-text); cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 10px; }
.send:hover { background: var(--vp-button-brand-hover-bg); }
.send:disabled { opacity: 0.6; cursor: progress; }
.send kbd { font-family: var(--vp-font-family-mono); font-size: 0.72rem; opacity: 0.7; }

@media (max-width: 980px) {
  .agent { position: static; max-height: none; }
}
@media (max-width: 640px) {
  .verbs { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); }
}
@media (max-width: 640px), (pointer: coarse) {
  .budget input { min-height: 44px; }
}
</style>
