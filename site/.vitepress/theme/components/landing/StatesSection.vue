<script setup lang="ts">
/**
 * The protocol, state by state: intent, proposal, policy, consent, receipt and undo, each
 * beside the real output of the exchange the hero runs, recorded from the core.
 */
import { RECORDED } from './exchange';
import LensBlock from './LensBlock.vue';
import { FOR_MODELS, STATES, type StateKey } from './states';

const { params, policy, lens, slip, receipt } = RECORDED;
const items = params.items
  .map((i) => `{sku: "${i.sku}", qty: ${i.qty}}`)
  .join(', ');

/** Each state's recorded output. */
const OUTPUT: Record<
  Exclude<StateKey, 'policy'>,
  { text: string; label: string; consent?: boolean }
> = {
  intent: {
    text: `→ INTENT shop.order {items: [${items}], deliver: "${params.deliver}"}`,
    label: 'The intent the agent sends',
  },
  proposal: {
    text: lens.proposals,
    label: 'The proposals, as the model reads them',
  },
  consent: {
    text: `→ COMMIT ${slip.id}\n${lens.consent}`,
    label: "The service's answer to the agent's commit",
    consent: true,
  },
  receipt: {
    text: `→ COMMIT ${slip.id} + the person's consent grant\n${lens.receipt}\n→ UNDO ${receipt.id}\n${lens.undo}`,
    label: 'The receipt, then the undo',
  },
};

/** A grant token is long; show its start and end. */
const token = `${policy.grant.slice(0, 40)}…${policy.grant.slice(-12)}`;
</script>

<template>
  <section class="band" aria-labelledby="states-title">
    <div class="band-intro">
      <h2 id="states-title">From intent to undo</h2>
      <p class="prose">Every exchange moves through the same states. Here is one like the slip above, recorded from the core; its ids and dates are its own.</p>
    </div>

    <ol class="steps">
      <li v-for="(s, i) in STATES" :key="s.key" class="step">
        <span class="n" aria-hidden="true">{{ i + 1 }}</span>
        <div class="text">
          <h3>{{ s.title }}</h3>
          <p class="prose">{{ s.body }}</p>
        </div>
        <div class="out">
          <template v-if="s.key === 'policy'">
            <p class="sentence">{{ policy.sentence }}</p>
            <LensBlock :text="`${token}\n${policy.caveats.join('\n')}`" label="The signed grant and its caveats" />
          </template>
          <LensBlock v-else v-bind="OUTPUT[s.key]" />
        </div>
      </li>
    </ol>

    <dl class="models">
      <div v-for="[term, text] in FOR_MODELS" :key="term">
        <dt>{{ term }}</dt>
        <dd>{{ text }}</dd>
      </div>
    </dl>
  </section>
</template>

<style scoped>
.steps { list-style: none; margin: 0; padding: 0; display: grid; gap: clamp(40px, 5vw, 64px); }
.step { display: grid; grid-template-columns: 2.5rem minmax(0, 5fr) minmax(0, 7fr); gap: 16px clamp(20px, 3vw, 40px); align-items: start; }
.n { font-size: 1rem; font-weight: 700; line-height: 1.9; font-variant-numeric: tabular-nums; width: 2rem; height: 2rem; display: grid; place-items: center; border: 1px solid var(--vp-c-border); border-radius: 50%; }
.text { display: grid; gap: 10px; }
.out { display: grid; gap: 14px; min-width: 0; }
.sentence { font-size: clamp(1.2rem, 1rem + 0.7vw, 1.45rem); font-weight: 650; line-height: 1.35; letter-spacing: -0.01em; }
.models { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 24px clamp(20px, 3vw, 40px); margin: clamp(56px, 7vw, 88px) 0 0; padding-top: 32px; border-top: 1px solid var(--vp-c-divider); }
.models dt { font-weight: 700; }
.models dd { margin: 6px 0 0; color: var(--vp-c-text-2); }

@media (max-width: 860px) {
  .step { grid-template-columns: 2.5rem minmax(0, 1fr); }
  .out { grid-column: 1 / -1; }
  .models { grid-template-columns: 1fr; }
}
/* Phones: the number sits on the heading's line, and the body and output take the full width. */
@media (max-width: 640px) {
  .step { grid-template-columns: 2rem minmax(0, 1fr); gap: 12px; }
  .text { display: contents; }
  .n { grid-row: 1; align-self: center; }
  .text h3 { grid-column: 2; grid-row: 1; align-self: center; }
  .text p { grid-column: 1 / -1; }
}
</style>
